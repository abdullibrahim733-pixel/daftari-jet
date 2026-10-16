/**
 * Runtime provider configuration.
 *
 * Every managed provider is opt-in through an explicit selector variable and the
 * default is always the offline local/mock adapter, so a missing variable can
 * never silently point a deployment at a mock.
 *
 * A selector that names a provider without its credentials fails fast with a
 * message that identifies the missing variable, instead of failing later inside
 * a request. Provider selection itself stays in `createIntegrations()`: this
 * module only answers "which provider" and "with what configuration".
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function required(name: string, purpose: string): string {
  const value = optional(name);
  if (!value) throw new ConfigError(`${name} is required ${purpose}`);
  return value;
}

function choice<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = optional(name);
  if (!value) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function flag(name: string): boolean {
  const value = optional(name)?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/* --------------------------------------------------------------- WhatsApp */

export type WhatsAppProvider = 'local' | 'twilio';

export function whatsappProvider(): WhatsAppProvider {
  return choice('DAFTARI_WHATSAPP_PROVIDER', ['local', 'twilio'] as const, 'local');
}

/**
 * Whether the WhatsApp ingestion path accepts deliveries.
 *
 * Disabled by default while the in-app recorder is the supported intake path.
 * The webhook route refuses deliveries when this is off, so the adapter and its
 * tests stay intact for when WhatsApp is re-enabled.
 */
export function whatsappIngestionEnabled(): boolean {
  return flag('DAFTARI_WHATSAPP_ENABLED');
}

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** Bare E.164 number the business chats with, without the `whatsapp:` prefix. */
  fromNumber: string;
};

/** Normalizes a Twilio address (`whatsapp:+255...`) to its bare E.164 form. */
export function normalizeWhatsAppAddress(value: string): string {
  return value.trim().replace(/^whatsapp:/i, '');
}

export function twilioConfig(): TwilioConfig {
  return {
    accountSid: required('TWILIO_ACCOUNT_SID', 'to verify Twilio webhook signatures'),
    authToken: required('TWILIO_AUTH_TOKEN', 'to verify Twilio webhook signatures and download media'),
    fromNumber: normalizeWhatsAppAddress(
      required('TWILIO_WHATSAPP_NUMBER', 'to match inbound WhatsApp deliveries'),
    ),
  };
}

/* ---------------------------------------------------------------- storage */

export type StorageProvider = 'local' | 's3' | 'blob';

export function storageProvider(): StorageProvider {
  return choice('DAFTARI_STORAGE_PROVIDER', ['local', 's3', 'blob'] as const, 'local');
}

/**
 * Vercel Blob store id.
 *
 * The SDK pairs it with the short-lived OIDC token Vercel injects at runtime, so
 * this is the only variable the deployment must supply; there is no static key.
 */
export function blobStoreId(): string {
  return required('BLOB_STORE_ID', 'to store private media in Vercel Blob');
}

export type S3Config = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string | undefined;
  forcePathStyle: boolean;
  prefix: string;
  /** Server-side encryption header, or `undefined` when disabled. */
  serverSideEncryption: string | undefined;
};

export function s3Config(): S3Config {
  // A managed deployment has no stable data directory, so signed media links
  // must be authorized by an explicit shared secret instead of the dev fallback.
  required('DAFTARI_MEDIA_SIGNING_SECRET', 'so signed media links verify across instances');
  const sse = optional('S3_SSE');
  return {
    bucket: required('S3_BUCKET', 'to store private media objects'),
    region: optional('S3_REGION') ?? 'us-east-1',
    accessKeyId: required('S3_ACCESS_KEY_ID', 'to reach the private media bucket'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY', 'to reach the private media bucket'),
    endpoint: optional('S3_ENDPOINT'),
    forcePathStyle: flag('S3_FORCE_PATH_STYLE'),
    prefix: (optional('S3_PREFIX') ?? 'daftari-media').replace(/^\/+|\/+$/g, ''),
    serverSideEncryption: sse === 'none' ? undefined : (sse ?? 'AES256'),
  };
}

/* ------------------------------------------------------- speech/extraction */

export type SpeechProvider = 'mock' | 'openai';
/**
 * Extraction providers.
 *
 * `off` is the supported mode while no model should read merchant transcripts:
 * the pipeline still creates a proposal, but it is an empty draft the reviewer
 * classifies and completes by hand instead of a model guess.
 */
export type ExtractionProvider = 'off' | 'mock' | 'openai';

export function speechProvider(): SpeechProvider {
  return choice('DAFTARI_SPEECH_PROVIDER', ['mock', 'openai'] as const, 'mock');
}

export function extractionProvider(): ExtractionProvider {
  return choice('DAFTARI_EXTRACTION_PROVIDER', ['off', 'mock', 'openai'] as const, 'mock');
}

export type OpenAiConfig = {
  apiKey: string;
  baseUrl: string;
  transcribeModel: string;
  extractionModel: string;
};

export function openAiConfig(): OpenAiConfig {
  const baseUrl = optional('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';
  return {
    apiKey: required('OPENAI_API_KEY', 'to use the OpenAI speech or extraction provider'),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    transcribeModel: optional('OPENAI_TRANSCRIBE_MODEL') ?? 'whisper-1',
    extractionModel: optional('OPENAI_EXTRACTION_MODEL') ?? 'gpt-4o-mini',
  };
}

/* ------------------------------------------------------------------ misc */

/** Shared secret that authorizes the scheduled job endpoint. */
export function cronSecret(): string | null {
  return optional('DAFTARI_CRON_SECRET') ?? optional('CRON_SECRET') ?? null;
}

/** Lifetime of a signed private-media link, in seconds. Capped at one day. */
export function mediaUrlTtlSeconds(): number {
  const parsed = Number.parseInt(optional('DAFTARI_MEDIA_URL_TTL_SECONDS') ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 300;
  return Math.min(parsed, 86_400);
}
