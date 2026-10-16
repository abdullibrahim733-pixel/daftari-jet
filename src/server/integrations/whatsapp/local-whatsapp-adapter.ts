/**
 * Local WhatsApp adapter used for development.
 *
 * It speaks the same signature scheme as a managed provider (HMAC over
 * `timestamp.rawBody`) so the webhook route has no development-only branch, and
 * it never talks to the network. The local simulator in
 * `src/app/api/v1/dev/**` produces the signed payloads.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseInboundMessage, type InboundMessage, type WhatsAppAdapter } from './port';

function webhookSecret(): string {
  return process.env.DAFTARI_WEBHOOK_SECRET?.trim() || 'daftari-local-webhook-secret';
}

export function signLocalWebhook(rawBody: string, timestamp: string): string {
  const digest = createHmac('sha256', webhookSecret())
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `sha256=${digest}`;
}

export const localWhatsAppAdapter: WhatsAppAdapter = {
  name: 'whatsapp-local',

  verifySignature({ rawBody, signature, timestamp }): boolean {
    if (!signature || !timestamp) return false;
    const expected = signLocalWebhook(rawBody, timestamp);
    const provided = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (provided.length !== expectedBuffer.length) return false;
    return timingSafeEqual(provided, expectedBuffer);
  },

  parseEvent({ rawBody }): InboundMessage {
    return parseInboundMessage(rawBody);
  },
};