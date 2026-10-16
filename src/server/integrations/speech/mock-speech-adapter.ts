/**
 * Offline speech adapter used in development.
 *
 * It recognises the synthetic voice notes created by the local WhatsApp
 * simulator: the simulator writes the spoken text into the object's metadata,
 * and this adapter "transcribes" it with a deterministic confidence score. No
 * merchant audio or transcript ever leaves the machine.
 *
 * Swap this for a managed provider by implementing `SpeechAdapter`.
 */

import type { SpeechAdapter, TranscriptionRequest, TranscriptionResult } from './port';
import { ProviderError } from './port';
import { readSyntheticMetadata } from './synthetic-audio';

export const mockSpeechAdapter: SpeechAdapter = {
  name: 'mock-speech-local',

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const metadata = readSyntheticMetadata(request.objectKey);
    if (!metadata) {
      throw new ProviderError(
        'media_unreadable',
        'The mock speech adapter can only read synthetic media created by the simulator',
        false,
      );
    }
    if (metadata.scriptedFailure === 'unsupported_media') {
      throw new ProviderError('unsupported_media', 'Unsupported media type', false);
    }
    if (metadata.scriptedFailure === 'no_speech') {
      throw new ProviderError('no_speech_detected', 'No speech was detected in this voice note', false);
    }
    if (metadata.scriptedFailure === 'provider_outage') {
      throw new ProviderError('provider_unavailable', 'Speech provider is temporarily unavailable', true);
    }
    if (metadata.scriptedFailure === 'too_long') {
      throw new ProviderError('audio_too_long', 'Voice note is longer than supported', false);
    }

    const text = metadata.transcript ?? '';
    if (text.trim().length === 0) {
      throw new ProviderError('empty_transcript', 'The transcript was empty', false);
    }

    const durationSeconds = metadata.durationSeconds ?? 6;
    const words = text.split(/\s+/).filter(Boolean);
    // Deterministic, explainable quality signal: longer and cleaner inputs score
    // higher. It is triage information only and never shown as a guarantee.
    const noisePenalty = Math.min(0.3, (metadata.noiseDb ?? 0) / 40);
    const confidence = Math.max(0.35, Math.min(0.97, 0.95 - noisePenalty - (words.length < 4 ? 0.2 : 0)));

    return {
      text,
      detectedLanguage: metadata.language ?? 'sw',
      provider: 'mock-speech-local',
      modelVersion: 'mock-stt-v1',
      quality: {
        confidence,
        noSpeechProbability: Number((1 - confidence).toFixed(2)),
        durationSeconds,
        segmentCount: Math.max(1, Math.round(durationSeconds / 2)),
      },
      segments: [
        { startSeconds: 0, endSeconds: durationSeconds, text },
      ],
    };
  },
};