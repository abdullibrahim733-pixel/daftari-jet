/**
 * In-app voice capture.
 *
 * The recorder posts audio bytes; this service stores them in private media
 * storage, records a source event that attributes the recording to the signed-in
 * user, and enqueues transcription. Nothing is transcribed inline, so the HTTP
 * response stays fast and a slow provider can never lose the recording.
 *
 * A capture is idempotent per (business, captureId): a retried upload returns the
 * source event that already exists instead of storing the audio twice.
 */

import { withTransaction, type Db } from '@/server/db/client';
import { nowIso } from '@/server/db/ids';
import { validationFailed } from '@/lib/errors';
import type { BusinessContext } from '@/server/business-context/context';
import { integrations } from '@/server/integrations';
import {
  findSourceEventByDedupeKey,
  insertMediaAsset,
  insertSourceEvent,
} from '@/server/repositories/source.repository';
import { mediaRetentionDeadline } from './media-acquisition';
import { enqueueTranscription } from './jobs';
import { recordAuditSafely } from './audit';

/** Whisper rejects audio over 25 MB, so nothing larger is accepted. */
export const MAX_CAPTURE_BYTES = 25 * 1024 * 1024;

const ALLOWED_MEDIA_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/m4a',
  'audio/x-m4a',
];

/** Trims parameters such as `;codecs=opus` that MediaRecorder appends. */
export function normalizeMediaType(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? '';
}

export function isSupportedCaptureMediaType(value: string): boolean {
  return ALLOWED_MEDIA_TYPES.includes(normalizeMediaType(value));
}

/** Checks the container signature instead of trusting a client-supplied MIME type. */
export function hasSupportedCaptureSignature(bytes: Uint8Array, mediaType: string): boolean {
  const type = normalizeMediaType(mediaType);
  const ascii = (start: number, value: string) =>
    [...value].every((char, index) => bytes[start + index] === char.charCodeAt(0));

  switch (type) {
    case 'audio/webm':
      return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    case 'audio/ogg':
      return bytes.length >= 4 && ascii(0, 'OggS');
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return bytes.length >= 8 && ascii(4, 'ftyp');
    case 'audio/wav':
    case 'audio/x-wav':
      return bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WAVE');
    case 'audio/mpeg':
      return bytes.length >= 3 && (ascii(0, 'ID3') || (bytes[0] === 0xff && (bytes[1]! & 0xe6) === 0xe2));
    case 'audio/aac':
      return bytes.length >= 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
    default:
      return false;
  }
}

export type CaptureInput = {
  /** Client-generated id so a retried upload is not stored twice. */
  captureId: string;
  bytes: Buffer;
  mediaType: string;
  durationSeconds: number | null;
  /** When the merchant recorded it; defaults to now. */
  recordedAt?: string | null;
};

export type CaptureResult = {
  sourceEventId: string;
  mediaAssetId: string | null;
  deduped: boolean;
};

export async function captureVoiceRecording(
  db: Db,
  context: BusinessContext,
  input: CaptureInput,
): Promise<CaptureResult> {
  if (input.bytes.byteLength === 0) {
    throw validationFailed('The recording is empty');
  }
  if (input.bytes.byteLength > MAX_CAPTURE_BYTES) {
    throw validationFailed('The recording is too large');
  }
  if (!isSupportedCaptureMediaType(input.mediaType)) {
    throw validationFailed('That audio format is not supported', { mediaType: input.mediaType });
  }
  if (!hasSupportedCaptureSignature(input.bytes, input.mediaType)) {
    throw validationFailed('The uploaded file does not match the selected audio format');
  }

  const scope = { businessId: context.businessId };
  const dedupeKey = `capture:${input.captureId}`;
  const existing = await findSourceEventByDedupeKey(db, scope, dedupeKey);
  if (existing) {
    return { sourceEventId: existing.id, mediaAssetId: null, deduped: true };
  }

  // Store the audio before writing the source event so a storage failure cannot
  // leave a source event pointing at bytes that do not exist.
  const stored = await integrations().storage.putObject({
    businessId: context.businessId,
    bytes: input.bytes,
    mediaType: normalizeMediaType(input.mediaType),
    metadata: { captureId: input.captureId },
  });

  return withTransaction(async () => {
    const receivedAt = input.recordedAt ?? nowIso();
    const sourceEvent = await insertSourceEvent(db, {
      businessId: context.businessId,
      integrationId: null,
      providerEventId: input.captureId,
      eventType: 'in_app_voice',
      senderRef: context.userId,
      receivedAt,
      providerSentAt: receivedAt,
      dedupeKey,
      redactedPayload: {
        kind: 'voice',
        captureId: input.captureId,
        mediaType: normalizeMediaType(input.mediaType),
        durationSeconds: input.durationSeconds,
      },
    });

    const media = await insertMediaAsset(db, {
      businessId: context.businessId,
      sourceEventId: sourceEvent.id,
      objectKey: stored.objectKey,
      mediaType: normalizeMediaType(input.mediaType),
      byteSize: stored.byteSize,
      durationSeconds: input.durationSeconds,
      checksum: stored.checksum,
      retentionDeadline: mediaRetentionDeadline(context.retentionAudioDays),
    });

    await enqueueTranscription(db, context.businessId, sourceEvent.id);
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'source_event.received',
      entityType: 'source_event',
      entityId: sourceEvent.id,
      actorUserId: context.userId,
      source: 'dashboard',
      after: {
        kind: 'in_app_voice',
        mediaAssetId: media.id,
        byteSize: stored.byteSize,
        durationSeconds: input.durationSeconds,
      },
    });

    return { sourceEventId: sourceEvent.id, mediaAssetId: media.id, deduped: false };
  }, db);
}
