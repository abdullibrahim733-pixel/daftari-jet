/**
 * Provider-media acquisition.
 *
 * A real WhatsApp provider hands over a media reference (Twilio's `MediaUrl0`)
 * that expires within minutes, so the webhook cannot store it during ingestion.
 * This service downloads that media into private storage, records the media
 * asset, and lets the job runner enqueue transcription afterwards.
 *
 * It deliberately imports neither `jobs.ts` nor `ingestion.ts`: ingestion
 * decides to enqueue `acquire_media`, and the job handler calls back in here.
 * Keeping that direction one-way avoids an import cycle.
 */

import type { Db } from '@/server/db/client';
import { fromJson, nowIso } from '@/server/db/ids';
import { addDaysToDateStr } from '@/lib/formatting/datetime';
import type { BusinessContext } from '@/server/business-context/context';
import { integrations } from '@/server/integrations';
import { ProviderError } from '@/server/integrations/provider-error';
import {
  findMediaAssetBySourceEvent,
  findSourceEventById,
  insertMediaAsset,
} from '@/server/repositories/source.repository';

export type AcquireOutcome =
  | { kind: 'acquired'; objectKey: string }
  | { kind: 'already_acquired' }
  | { kind: 'failed'; code: string; retryable: boolean };

export function mediaRetentionDeadline(retentionDays: number, now = nowIso()): string {
  const today = now.slice(0, 10);
  return `${addDaysToDateStr(today, Math.max(1, retentionDays))}T23:59:59.000Z`;
}

/**
 * Downloads and stores the media for one source event.
 *
 * Idempotent per source event: a retried job reuses the already-stored object
 * rather than downloading a second copy.
 */
export async function acquireMediaForSourceEvent(
  db: Db,
  context: BusinessContext,
  sourceEventId: string,
): Promise<AcquireOutcome> {
  const scope = { businessId: context.businessId };
  const sourceEvent = await findSourceEventById(db, scope, sourceEventId);
  if (!sourceEvent) return { kind: 'failed', code: 'source_event_not_found', retryable: false };

  const existing = await findMediaAssetBySourceEvent(db, scope, sourceEventId);
  if (existing) return { kind: 'already_acquired' };

  const redacted = fromJson<Record<string, unknown>>(sourceEvent.payload_redacted, {});
  const mediaRef = typeof redacted.mediaRef === 'string' ? redacted.mediaRef : null;
  const mediaMimeType = typeof redacted.mediaMimeType === 'string' ? redacted.mediaMimeType : undefined;
  const recordedDuration =
    typeof redacted.durationSeconds === 'number' ? redacted.durationSeconds : undefined;
  if (!mediaRef) return { kind: 'failed', code: 'media_reference_missing', retryable: false };

  const adapter = integrations().whatsapp;
  if (!adapter.fetchMedia) {
    return { kind: 'failed', code: 'media_download_unsupported', retryable: false };
  }

  let fetched;
  try {
    fetched = await adapter.fetchMedia({
      mediaRef,
      mediaMimeType,
      // Adapters that bill per account use this; Twilio authenticates at the
      // account level, so the tenant id is a safe fallback identifier.
      accountRef: context.businessId,
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      return { kind: 'failed', code: error.code, retryable: error.retryable };
    }
    throw error;
  }

  const stored = await integrations().storage.putObject({
    businessId: context.businessId,
    bytes: fetched.bytes,
    mediaType: fetched.mediaType,
    metadata: { sourceEventId },
  });

  await insertMediaAsset(db, {
    businessId: context.businessId,
    sourceEventId,
    objectKey: stored.objectKey,
    mediaType: fetched.mediaType,
    byteSize: stored.byteSize,
    durationSeconds: fetched.durationSeconds ?? recordedDuration ?? null,
    checksum: fetched.checksum,
    retentionDeadline: mediaRetentionDeadline(context.retentionAudioDays),
  });

  return { kind: 'acquired', objectKey: stored.objectKey };
}
