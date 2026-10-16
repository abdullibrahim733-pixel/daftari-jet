/**
 * WhatsApp webhook.
 *
 * This endpoint is public, so it verifies the provider signature before doing
 * anything else and answers as soon as the delivery is durably stored. The
 * transcript, extraction and proposal run in a job afterwards, so a slow
 * provider can never make WhatsApp redeliver the same message.
 */

import { ingestWhatsAppDelivery } from '@/server/services/ingestion';
import { whatsappIngestionEnabled } from '@/server/config/env';
import { getDatabase } from '@/server/db/client';
import { notFound } from '@/lib/errors';
import { route, ok, created } from '@/server/http/route';
import { logger } from '@/server/observability/logger';

/**
 * Reconstructs the absolute URL the provider signed.
 *
 * Vercel and other proxies terminate TLS in front of the app, so `request.url`
 * carries the internal origin. Twilio signs the public URL, so the forwarded
 * protocol and host are preferred when present.
 */
function publicRequestUrl(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const protocol = forwardedProto ?? url.protocol.replace(':', '');
  const host = forwardedHost ?? url.host;
  return `${protocol}://${host}${url.pathname}${url.search}`;
}

export const POST = route(async (request) => {
  // WhatsApp ingestion is off while the in-app recorder is the intake path. A
  // disabled endpoint is reported as absent so a probe cannot tell it apart
  // from one that was never configured.
  if (!whatsappIngestionEnabled()) {
    throw notFound();
  }

  const rawBody = await request.text();
  const signature =
    request.headers.get('x-twilio-signature') ??
    request.headers.get('x-daftari-signature') ??
    request.headers.get('x-hub-signature-256');
  const timestamp =
    request.headers.get('x-daftari-timestamp') ?? request.headers.get('x-hub-signature-timestamp');

  // Ingestion owns the enqueue decision: a media reference queues the download,
  // everything else queues transcription directly.
  const result = await ingestWhatsAppDelivery(getDatabase(), {
    rawBody,
    signature,
    timestamp,
    url: publicRequestUrl(request),
    contentType: request.headers.get('content-type'),
  });

  logger.info('webhook.accepted', {
    sourceEventId: result.sourceEventId,
    businessId: result.businessId,
    deduped: result.deduped,
  });

  return result.deduped
    ? ok({ accepted: true, deduped: true, sourceEventId: result.sourceEventId })
    : created({ accepted: true, deduped: false, sourceEventId: result.sourceEventId });
});
