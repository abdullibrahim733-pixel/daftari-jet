/**
 * WhatsApp Cloud API port.
 *
 * The webhook contract is intentionally small: the adapter only authenticates and
 * normalises a delivery. Storing the delivery, deduplicating it and processing
 * it are separate concerns owned by the platform, so an accepted webhook is
 * never reported as a processed message.
 */

import { z } from 'zod';

export const inboundMessageSchema = z.object({
  eventId: z.string().min(1),
  accountRef: z.string().min(1),
  kind: z.enum(['voice', 'text']),
  senderRef: z.string().min(1),
  senderName: z.string().min(1).optional(),
  providerSentAt: z.iso.datetime(),
  text: z.string().max(4096).optional(),
  mediaId: z.string().min(1).optional(),
  mediaMimeType: z.string().min(1).optional(),
  /**
   * Present when the provider already stored the media under an object
   * key we can read directly (local simulator). A real provider
   * instead returns a media id that the adapter downloads.
   */
  media: z
    .object({
      objectKey: z.string().min(1),
      mediaType: z.string().min(1),
      byteSize: z.number().int().nonnegative(),
      durationSeconds: z.number().nonnegative().optional(),
      checksum: z.string().min(1).optional(),
    })
    .optional(),
});

export type InboundMessage = z.infer<typeof inboundMessageSchema>;

/**
 * A raw webhook delivery plus the transport metadata a provider needs to
 * authenticate it. Local development only uses the body, signature and
 * timestamp; providers that sign the request URL (Twilio) also read `url` and
 * `contentType`.
 */
export type WebhookDelivery = {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  /** Absolute URL the provider signed, when the provider signs the URL. */
  url?: string | null;
  /** Lower-cased `Content-Type` header, when it changes how the body is read. */
  contentType?: string | null;
};

export type MediaFetchRequest = {
  /** Provider handle for the media (for Twilio, the account-scoped media URL). */
  mediaRef: string;
  mediaMimeType?: string;
  /** Provider account the media belongs to, for adapters that bill per account. */
  accountRef: string;
};

export type FetchedMedia = {
  bytes: Buffer;
  mediaType: string;
  checksum: string;
  durationSeconds?: number;
};

export interface WhatsAppAdapter {
  readonly name: string;
  /** Constant-time check of the provider signature over the raw body/URL. */
  verifySignature(delivery: WebhookDelivery): boolean;
  parseEvent(delivery: WebhookDelivery): InboundMessage;
  /**
   * Downloads provider-hosted media into bytes. Absent for adapters that hand
   * over an already-stored object key directly.
   */
  fetchMedia?(request: MediaFetchRequest): Promise<FetchedMedia>;
}

export function parseInboundMessage(rawBody: string): InboundMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new Error('Webhook body is not valid JSON');
  }
  return inboundMessageSchema.parse(decoded);
}