/**
 * In-app voice capture endpoint.
 *
 * Accepts a multipart upload from the recorder page, stores the audio in private
 * media storage and enqueues transcription. The response returns as soon as the
 * recording is durable; the transcript and draft proposal are produced by the
 * job runner afterwards.
 */

import { z } from 'zod';
import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { captureVoiceRecording, MAX_CAPTURE_BYTES } from '@/server/services/capture';
import { runDueJobs } from '@/server/services/jobs';
import { validationFailed } from '@/lib/errors';
import { created, readBoundedBody, route } from '@/server/http/route';

export const maxDuration = 60;

const MAX_CAPTURE_REQUEST_BYTES = MAX_CAPTURE_BYTES + 64 * 1024;

const captureFieldsSchema = z.object({
  captureId: z.string().trim().min(8).max(80),
  recordedAt: z.iso.datetime().optional(),
});

function durationFrom(form: FormData): number | null {
  const raw = form.get('durationSeconds');
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 86_400) return null;
  return value;
}

export const POST = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'records.capture');

  const body = await readBoundedBody(request, MAX_CAPTURE_REQUEST_BYTES);
  const bodyBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(bodyBuffer).set(body);
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bodyBuffer,
  });
  let form: FormData;
  try {
    form = await boundedRequest.formData();
  } catch {
    throw validationFailed('The upload form is not valid');
  }
  const file = form.get('audio');
  if (!(file instanceof File)) {
    throw validationFailed('Attach the recording as the "audio" field');
  }
  if (file.size === 0) {
    throw validationFailed('The recording is empty');
  }
  if (file.size > MAX_CAPTURE_BYTES) {
    throw validationFailed('The recording is too large');
  }

  const parsed = captureFieldsSchema.safeParse({
    captureId: form.get('captureId'),
    ...(typeof form.get('recordedAt') === 'string' ? { recordedAt: form.get('recordedAt') } : {}),
  });
  if (!parsed.success) {
    throw validationFailed('The recording is missing information', {
      fields: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
    });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await captureVoiceRecording(db, context, {
    captureId: parsed.data.captureId,
    bytes,
    mediaType: file.type || 'application/octet-stream',
    durationSeconds: durationFrom(form),
    recordedAt: parsed.data.recordedAt ?? null,
  });

  // The scheduled runner remains the source of truth for retries, but a capture
  // should not wait for the next (daily) schedule tick to become a draft. Drain
  // the queue now so the recorder's "open review" step already has a proposal.
  try {
    await runDueJobs(db, { limit: 5 });
  } catch {
    // Transcription is durable and retried by the job runner; a capture must
    // still succeed even if processing cannot start right now.
  }

  return created({
    sourceEventId: result.sourceEventId,
    mediaAssetId: result.mediaAssetId,
    deduped: result.deduped,
  });
});
