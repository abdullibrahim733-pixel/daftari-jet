/**
 * Twilio WhatsApp adapter.
 *
 * Twilio posts `application/x-www-form-urlencoded` bodies and authenticates the
 * request with an HMAC-SHA1 signature over the full request URL plus the sorted
 * form parameters (header `X-Twilio-Signature`), not over the raw body. Voice
 * notes arrive as `MediaUrl0`, which the adapter downloads with HTTP Basic auth.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeWhatsAppAddress, type TwilioConfig } from '@/server/config/env';
import { ProviderError } from '../provider-error';
import type {
  FetchedMedia,
  InboundMessage,
  MediaFetchRequest,
  WebhookDelivery,
  WhatsAppAdapter,
} from './port';

function formParams(rawBody: string, contentType: string | null | undefined): Record<string, string> {
  const type = contentType ?? '';
  if (type.includes('application/json')) {
    const decoded = JSON.parse(rawBody) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(decoded).map(([key, value]) => [key, value === null || value === undefined ? '' : String(value)]),
    );
  }
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawBody)) params[key] = value;
  return params;
}

export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((accumulator, key) => accumulator + key + (params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64');
}

function mediaHeader(params: Record<string, string>): { url: string | null; mimeType: string | null } {
  const mediaUrl = params.MediaUrl0 ?? null;
  const mimeType = params.MediaContentType0 ?? null;
  return { url: mediaUrl, mimeType };
}

export function createTwilioWhatsAppAdapter(
  config: TwilioConfig,
  options: { fetchImpl?: typeof fetch } = {},
): WhatsAppAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: 'whatsapp-twilio',

    verifySignature(delivery: WebhookDelivery): boolean {
      if (!delivery.signature || !delivery.url) return false;
      let params: Record<string, string>;
      try {
        params = formParams(delivery.rawBody, delivery.contentType);
      } catch {
        return false;
      }
      const expected = computeTwilioSignature(config.authToken, delivery.url, params);
      const providedBuffer = Buffer.from(delivery.signature, 'utf8');
      const expectedBuffer = Buffer.from(expected, 'utf8');
      if (providedBuffer.length !== expectedBuffer.length) return false;
      return timingSafeEqual(providedBuffer, expectedBuffer);
    },

    parseEvent(delivery: WebhookDelivery): InboundMessage {
      const params = formParams(delivery.rawBody, delivery.contentType);
      const eventId = params.MessageSid ?? params.SmsMessageSid;
      const from = params.From;
      const to = params.To;
      if (!eventId || !from || !to) {
        throw new Error('Twilio webhook is missing MessageSid/From/To');
      }

      const media = mediaHeader(params);
      const isAudio = media.url !== null && (media.mimeType ?? '').toLowerCase().startsWith('audio/');

      return {
        eventId,
        accountRef: normalizeWhatsAppAddress(to),
        senderRef: normalizeWhatsAppAddress(from),
        senderName: params.ProfileName || undefined,
        // Twilio does not expose the sender's original timestamp reliably, so
        // receipt time is the only trustworthy value.
        providerSentAt: new Date().toISOString(),
        kind: isAudio ? 'voice' : 'text',
        text: isAudio ? undefined : params.Body || undefined,
        mediaId: isAudio ? (media.url ?? undefined) : undefined,
        mediaMimeType: isAudio ? (media.mimeType ?? undefined) : undefined,
      };
    },

    async fetchMedia(request: MediaFetchRequest): Promise<FetchedMedia> {
      const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
      let response: Response;
      try {
        response = await fetchImpl(request.mediaRef, {
          headers: { authorization: `Basic ${credentials}` },
        });
      } catch (error) {
        throw new ProviderError('media_download_failed', String(error), true);
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new ProviderError('media_download_failed', `Twilio media responded ${response.status}`, retryable);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const headerType = response.headers.get('content-type')?.split(';')[0]?.trim();
      return {
        bytes,
        mediaType: headerType || request.mediaMimeType || 'application/octet-stream',
        checksum: createHash('sha256').update(bytes).digest('hex'),
      };
    },
  };
}
