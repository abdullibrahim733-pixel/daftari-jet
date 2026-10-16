/**
 * Adapter selection.
 *
 * One module owns which implementation is in use, so no feature code ever
 * branches on an environment flag. Managed providers are added here and nowhere
 * else.
 */

import {
  blobStoreId,
  extractionProvider,
  openAiConfig,
  s3Config,
  speechProvider,
  storageProvider,
  twilioConfig,
  whatsappProvider,
} from '@/server/config/env';
import { manualDraftExtractionAdapter } from './extraction/manual-draft-adapter';
import { mockExtractionAdapter } from './extraction/mock-extraction-adapter';
import { createOpenAiExtractionAdapter } from './extraction/openai-extraction-adapter';
import type { ExtractionAdapter } from './extraction/port';
import { mockSpeechAdapter } from './speech/mock-speech-adapter';
import { createOpenAiSpeechAdapter } from './speech/openai-speech-adapter';
import type { SpeechAdapter } from './speech/port';
import { localMediaStorage } from './storage/local-storage-adapter';
import { createS3MediaStorage } from './storage/s3-storage-adapter';
import { createVercelBlobStorage } from './storage/vercel-blob-storage-adapter';
import type { MediaStorageAdapter } from './storage/port';
import { localWhatsAppAdapter } from './whatsapp/local-whatsapp-adapter';
import { createTwilioWhatsAppAdapter } from './whatsapp/twilio-whatsapp-adapter';
import type { WhatsAppAdapter } from './whatsapp/port';

export type Integrations = {
  storage: MediaStorageAdapter;
  speech: SpeechAdapter;
  extraction: ExtractionAdapter;
  whatsapp: WhatsAppAdapter;
};

export function createIntegrations(): Integrations {
  const storageProviderName = storageProvider();
  const storage: MediaStorageAdapter =
    storageProviderName === 's3'
      ? createS3MediaStorage(s3Config())
      : storageProviderName === 'blob'
        ? createVercelBlobStorage(blobStoreId())
        : localMediaStorage;

  // A managed speech provider needs to reach the same private storage the
  // pipeline reads from, so it is constructed with the storage adapter.
  const speech: SpeechAdapter =
    speechProvider() === 'openai'
      ? createOpenAiSpeechAdapter({ storage, config: openAiConfig() })
      : mockSpeechAdapter;

  const extractionProviderName = extractionProvider();
  const extraction: ExtractionAdapter =
    extractionProviderName === 'openai'
      ? createOpenAiExtractionAdapter({ config: openAiConfig() })
      : extractionProviderName === 'off'
        ? manualDraftExtractionAdapter
        : mockExtractionAdapter;

  const whatsapp: WhatsAppAdapter =
    whatsappProvider() === 'twilio'
      ? createTwilioWhatsAppAdapter(twilioConfig())
      : localWhatsAppAdapter;

  return { storage, speech, extraction, whatsapp };
}

let cached: Integrations | null = null;

export function integrations(): Integrations {
  cached ??= createIntegrations();
  return cached;
}

/**
 * Swaps adapters for the current process and returns a restore function.
 *
 * This is the seam real providers plug into and the one tests use to exercise
 * provider failures, which are otherwise impossible to trigger with the
 * deterministic local adapters.
 */
export function overrideIntegrations(overrides: Partial<Integrations>): () => void {
  const previous = cached;
  cached = { ...integrations(), ...overrides };
  return () => {
    cached = previous;
  };
}