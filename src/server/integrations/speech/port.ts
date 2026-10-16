/**
 * Speech-to-text port.
 *
 * Swahili and English are explicit product requirements and voice language can
 * vary per utterance, so language is detected per message rather than assumed
 * from the dashboard language. Model output is treated as untrusted input.
 */

export type TranscriptionSegment = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export type TranscriptionRequest = {
  businessId: string;
  objectKey: string;
  mediaType: string;
  byteSize: number;
  /** Hint only; the adapter still reports the detected language. */
  languageHint?: string;
  timezone: string;
};

export type TranscriptionResult = {
  text: string;
  detectedLanguage: string;
  provider: string;
  modelVersion: string;
  quality: {
    confidence?: number;
    averageLogprob?: number;
    noSpeechProbability?: number;
    durationSeconds?: number;
    segmentCount?: number;
  };
  segments?: TranscriptionSegment[];
};

export { ProviderError } from '../provider-error';

export interface SpeechAdapter {
  readonly name: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}