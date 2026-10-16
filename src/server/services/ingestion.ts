/**
 * WhatsApp webhook ingestion.
 *
 * The route's job ends here: authenticate the delivery, deduplicate it,
 * persist the source event with redacted metadata, store or link the
 * private media, and enqueue transcription. Nothing is transcribed or
 * extracted synchronously, so a webhook response is never slowed by
 * provider calls and a slow provider can never lose a message.
 *
 * Delivery acceptance is deliberately separate from processing success:
 * the webhook returns 202 once the delivery is durable, even though
 * transcription may fail and be retried later.
 */

import { withTransaction, type Db } from '@/server/db/client';
import { nowIso } from '@/server/db/ids';
import { conflict, ERROR_CODES, notFound, signatureInvalid } from '@/lib/errors';
import type { BusinessContext } from '@/server/business-context/context';
import { integrations } from '@/server/integrations';
import {
  findIntegrationByProviderAccount,
  findBusinessById,
  recordIntegrationWebhook,
  type IntegrationRow,
} from '@/server/repositories/business.repository';
import {
  findSourceEventByDedupe,
  insertMediaAsset,
  insertSourceEvent,
  insertTranscript,
  type MediaAssetRow,
} from '@/server/repositories/source.repository';
import { businessContextForJob } from './context-builder';
import { enqueueMediaAcquisition, enqueueTranscription } from './jobs';
import { mediaRetentionDeadline } from './media-acquisition';
import { recordAuditSafely } from './audit';

const WHATSAPP_PROVIDER = 'whatsapp';

export type IngestDelivery = {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  /** Absolute request URL, when the provider signs the URL (Twilio). */
  url?: string | null;
  /** Lower-cased `Content-Type` header, when the provider posts a form body. */
  contentType?: string | null;
};

export type IngestResult = {
  sourceEventId: string;
  businessId: string;
  /** True when the provider redelivered an event we already stored. */
  deduped: boolean;
  /** Context for the tenant that owns the WhatsApp account. */
  context: BusinessContext;
};

/**
 * Ingests one signed WhatsApp delivery.
 *
 * Throws `signatureInvalid` for bad signatures, `notFound` when the
 * sending account is not connected, and `conflict` when the account is
 * not active.
 */
export async function ingestWhatsAppDelivery(
  db: Db,
  delivery: IngestDelivery,
): Promise<IngestResult> {
  const deps = integrations();

  if (!deps.whatsapp.verifySignature(delivery)) {
    throw signatureInvalid();
  }
  const message = deps.whatsapp.parseEvent(delivery);

  const integration = await findIntegrationByProviderAccount(
    db,
    WHATSAPP_PROVIDER,
    message.accountRef,
  );
  if (!integration) {
    throw notFound('No connected WhatsApp account matches this delivery');
  }
  if (integration.status !== 'connected') {
    throw conflict('INTEGRATION_NOT_CONNECTED', 'The WhatsApp account is not connected');
  }

  const businessId = integration.business_id;
  const dedupeKey = `provider_event:${message.eventId}`;
  const existing = await findSourceEventByDedupe(db, integration.id, message.eventId);
  if (existing) {
    return {
      sourceEventId: existing.id,
      businessId,
      deduped: true,
      context: await businessContextForJob(db, businessId),
    };
  }

  const business = await findBusinessById(db, businessId);
  if (!business || business.status !== 'active') {
    throw notFound('The business for this WhatsApp account is not available');
  }

  return withTransaction(async () => {
    const receivedAt = nowIso();
    const isProviderMedia = message.kind === 'voice' && !message.media?.objectKey && Boolean(message.mediaId);
    const sourceEvent = await insertSourceEvent(db, {
      businessId,
      integrationId: integration.id,
      providerEventId: message.eventId,
      eventType: message.kind === 'voice' ? 'whatsapp_voice' : 'whatsapp_text',
      senderRef: message.senderRef,
      receivedAt,
      providerSentAt: message.providerSentAt,
      dedupeKey,
      redactedPayload: {
        kind: message.kind,
        providerEventId: message.eventId,
        providerSentAt: message.providerSentAt,
        ...(message.kind === 'voice'
          ? {
              mediaType: message.media?.mediaType ?? message.mediaMimeType ?? null,
              durationSeconds: message.media?.durationSeconds ?? null,
              // A provider-hosted reference is stored so the acquire job can
              // download it later; the message body never lands here.
              ...(isProviderMedia
                ? { mediaRef: message.mediaId, mediaMimeType: message.mediaMimeType ?? null }
                : {}),
            }
          : {}),
      },
    });

    let media: MediaAssetRow | undefined;
    let queued: 'transcribe_source' | 'acquire_media';

    if (message.kind === 'voice') {
      const mediaInfo = message.media;
      if (mediaInfo?.objectKey) {
        // The provider already stored the object under a key we can read.
        media = await insertMediaAsset(db, {
          businessId,
          sourceEventId: sourceEvent.id,
          objectKey: mediaInfo.objectKey,
          mediaType: mediaInfo.mediaType,
          byteSize: mediaInfo.byteSize,
          durationSeconds: mediaInfo.durationSeconds ?? null,
          checksum: mediaInfo.checksum ?? '',
          retentionDeadline: mediaRetentionDeadline(business.retention_audio_days),
        });
        queued = 'transcribe_source';
      } else if (message.mediaId) {
        // The provider only handed over a downloadable reference: store the
        // reference now and let the acquire job fetch the bytes.
        queued = 'acquire_media';
      } else {
        throw conflict(
          ERROR_CODES.VALIDATION_FAILED,
          'A voice message arrived without its media',
        );
      }
    } else {
      // The message body belongs to the transcript, never to the
      // redacted delivery payload.
      await insertTranscript(db, {
        businessId,
        sourceEventId: sourceEvent.id,
        mediaAssetId: null,
        machineText: message.text ?? '',
        detectedLanguage: 'unknown',
        provider: WHATSAPP_PROVIDER,
        modelVersion: 'text-v1',
        quality: { confidence: 1, segmentCount: 1 },
      });
      queued = 'transcribe_source';
    }

    await recordIntegrationWebhook(db, integration.id, receivedAt);
    if (queued === 'acquire_media') {
      await enqueueMediaAcquisition(db, businessId, sourceEvent.id);
    } else {
      await enqueueTranscription(db, businessId, sourceEvent.id);
    }
    await recordAuditSafely(db, {
      businessId,
      action: 'source_event.received',
      entityType: 'source_event',
      entityId: sourceEvent.id,
      actorType: 'system',
      source: 'webhook',
      after: {
        kind: message.kind,
        senderRef: message.senderRef,
        hasMedia: Boolean(media),
        queued,
      },
    });

    return {
      sourceEventId: sourceEvent.id,
      businessId,
      deduped: false,
      context: await businessContextForJob(db, businessId),
    };
  }, db);
}

/** Exposed for tests and the dev simulator. */
export async function integrationForRef(
  db: Db,
  accountRef: string,
): Promise<IntegrationRow | undefined> {
  return await findIntegrationByProviderAccount(db, WHATSAPP_PROVIDER, accountRef);
}
