/**
 * OpenAI Whisper speech-to-text adapter.
 *
 * Audio is read from private storage, sent to the transcription endpoint as a
 * multipart upload, and the verbose response is normalised into a transcript.
 * The upload is never logged and the object key never leaves the server.
 */

import { ProviderError } from '../provider-error';
import type { OpenAiConfig } from '@/server/config/env';
import type { MediaStorageAdapter } from '../storage/port';
import type { SpeechAdapter, TranscriptionResult, TranscriptionSegment } from './port';

const TRANSIENT_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function providerErrorFor(status: number, detail: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError('speech_auth_failed', `OpenAI rejected the credentials: ${detail}`, false);
  }
  if (status === 400 || status === 422) {
    return new ProviderError('speech_rejected', `OpenAI rejected the audio: ${detail}`, false);
  }
  return new ProviderError('speech_unavailable', `OpenAI responded ${status}: ${detail}`, TRANSIENT_STATUSES.has(status));
}

function normalizeSegments(value: unknown): TranscriptionSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments = value
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null;
      const record = entry as Record<string, unknown>;
      const text = typeof record.text === 'string' ? record.text : '';
      const start = typeof record.start === 'number' ? record.start : Number(record.start);
      const end = typeof record.end === 'number' ? record.end : Number(record.end);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;
      return { startSeconds: start, endSeconds: end, text };
    })
    .filter((segment): segment is TranscriptionSegment => segment !== null);
  return segments.length > 0 ? segments : undefined;
}

export function createOpenAiSpeechAdapter(deps: {
  storage: MediaStorageAdapter;
  config: OpenAiConfig;
  fetchImpl?: typeof fetch;
}): SpeechAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    name: 'openai-whisper',

    async transcribe(request): Promise<TranscriptionResult> {
      const bytes = await deps.storage.readObject(request.objectKey);

      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: request.mediaType }), 'audio');
      form.append('model', deps.config.transcribeModel);
      form.append('response_format', 'verbose_json');
      if (request.languageHint) {
        form.append('language', request.languageHint.slice(0, 2).toLowerCase());
      }

      let response: Response;
      try {
        response = await fetchImpl(`${deps.config.baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${deps.config.apiKey}` },
          body: form,
        });
      } catch (error) {
        throw new ProviderError('speech_unavailable', String(error), true);
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw providerErrorFor(response.status, detail);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text) {
        throw new ProviderError('speech_empty', 'The transcription contained no speech', false);
      }

      const duration = typeof payload.duration === 'number' ? payload.duration : undefined;
      const segments = normalizeSegments(payload.segments);

      return {
        text,
        detectedLanguage: typeof payload.language === 'string' ? payload.language : 'unknown',
        provider: 'openai-whisper',
        modelVersion: deps.config.transcribeModel,
        quality: {
          durationSeconds: duration,
          segmentCount: segments?.length,
        },
        segments,
      };
    },
  };
}
