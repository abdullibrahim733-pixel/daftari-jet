/**
 * Managed provider adapters.
 *
 * These exercise the highest-risk new code path: signing/verifying provider
 * deliveries, downloading provider media, and normalizing model output. The
 * network is always replaced by an injected fetch, so the tests assert the exact
 * contract the adapters promise without ever calling a provider.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeTwilioSignature, createTwilioWhatsAppAdapter } from '@/server/integrations/whatsapp/twilio-whatsapp-adapter';
import { createOpenAiSpeechAdapter } from '@/server/integrations/speech/openai-speech-adapter';
import { createOpenAiExtractionAdapter } from '@/server/integrations/extraction/openai-extraction-adapter';
import { createS3MediaStorage } from '@/server/integrations/storage/s3-storage-adapter';
import { localMediaStorage } from '@/server/integrations/storage/local-storage-adapter';
import { ProviderError } from '@/server/integrations/provider-error';
import type { MediaStorageAdapter } from '@/server/integrations/storage/port';

const TWILIO = { accountSid: 'ACxxxxxxxx', authToken: 'twilio-auth-token', fromNumber: '+255700000001' };
const OPENAI = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  transcribeModel: 'whisper-1',
  extractionModel: 'gpt-4o-mini',
};

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function storageStub(readObject: () => Promise<Buffer>): MediaStorageAdapter {
  return {
    name: 'stub',
    readObject,
    putObject: async () => ({ objectKey: 'x', byteSize: 0, checksum: '' }),
    deleteObject: async () => {},
    createSignedLink: () => ({ token: '', expiresAt: '' }),
    verifySignedLink: () => null,
    objectExists: () => true,
  };
}

describe('Twilio WhatsApp adapter', () => {
  const adapter = createTwilioWhatsAppAdapter(TWILIO);
  const url = 'https://shop.example.com/api/v1/webhooks/whatsapp';

  it('accepts a delivery signed over the URL and sorted form params', () => {
    const rawBody = formBody({ MessageSid: 'SM1', From: 'whatsapp:+255711111111', To: 'whatsapp:+255700000001', Body: 'Habari' });
    const signature = computeTwilioSignature(TWILIO.authToken, url, Object.fromEntries(new URLSearchParams(rawBody)));

    assert.equal(
      adapter.verifySignature({ rawBody, signature, timestamp: null, url, contentType: 'application/x-www-form-urlencoded' }),
      true,
    );
  });

  it('rejects a signature computed over a different URL', () => {
    const rawBody = formBody({ MessageSid: 'SM1', From: 'whatsapp:+255711111111', To: 'whatsapp:+255700000001' });
    const signature = computeTwilioSignature(TWILIO.authToken, 'https://evil.example.com/hook', Object.fromEntries(new URLSearchParams(rawBody)));

    assert.equal(
      adapter.verifySignature({ rawBody, signature, timestamp: null, url, contentType: 'application/x-www-form-urlencoded' }),
      false,
    );
  });

  it('parses an audio delivery into a voice message with a media reference', () => {
    const rawBody = formBody({
      MessageSid: 'SM2',
      From: 'whatsapp:+255711111111',
      To: 'whatsapp:+255700000001',
      ProfileName: 'Joseph',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC/media/ME',
      MediaContentType0: 'audio/ogg',
    });

    const message = adapter.parseEvent({ rawBody, signature: null, timestamp: null, contentType: 'application/x-www-form-urlencoded' });

    assert.equal(message.kind, 'voice');
    assert.equal(message.eventId, 'SM2');
    assert.equal(message.accountRef, '+255700000001');
    assert.equal(message.senderRef, '+255711111111');
    assert.equal(message.mediaId, 'https://api.twilio.com/2010-04-01/Accounts/AC/media/ME');
    assert.equal(message.mediaMimeType, 'audio/ogg');
    assert.equal(message.text, undefined);
  });

  it('parses a text delivery without treating it as voice', () => {
    const rawBody = formBody({ MessageSid: 'SM3', From: 'whatsapp:+255711111111', To: 'whatsapp:+255700000001', NumMedia: '0', Body: 'Nimeuza leo' });
    const message = adapter.parseEvent({ rawBody, signature: null, timestamp: null, contentType: 'application/x-www-form-urlencoded' });
    assert.equal(message.kind, 'text');
    assert.equal(message.text, 'Nimeuza leo');
  });

  it('downloads media with account basic auth and returns a checksum', async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get('authorization') });
      return new Response(new Uint8Array([0xff, 0xfb, 0x01]), {
        status: 200,
        headers: { 'content-type': 'audio/ogg' },
      });
    }) as typeof fetch;

    const mediaAdapter = createTwilioWhatsAppAdapter(TWILIO, { fetchImpl });
    const media = await mediaAdapter.fetchMedia?.({
      mediaRef: 'https://api.twilio.com/media/1',
      accountRef: '+255700000001',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.authorization, `Basic ${Buffer.from(`${TWILIO.accountSid}:${TWILIO.authToken}`).toString('base64')}`);
    assert.equal(media?.bytes.length, 3);
    assert.equal(media?.mediaType, 'audio/ogg');
    assert.match(media?.checksum ?? '', /^[0-9a-f]{64}$/);
  });

  it('marks a transient download failure as retryable', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    const mediaAdapter = createTwilioWhatsAppAdapter(TWILIO, { fetchImpl });

    await assert.rejects(
      async () => await mediaAdapter.fetchMedia?.({ mediaRef: 'https://api.twilio.com/media/1', accountRef: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });
});

describe('OpenAI speech adapter', () => {
  it('reads the object and normalizes the verbose transcription', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ text: 'Nimeuza leo', language: 'sw', duration: 6.2, segments: [{ start: 0, end: 6.2, text: 'Nimeuza leo' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const adapter = createOpenAiSpeechAdapter({
      storage: storageStub(async () => Buffer.from([0x01, 0x02])),
      config: OPENAI,
      fetchImpl,
    });

    const result = await adapter.transcribe({
      businessId: 'biz',
      objectKey: 'obj_1',
      mediaType: 'audio/ogg',
      byteSize: 2,
      timezone: 'Africa/Dar_es_Salaam',
    });

    assert.equal(result.text, 'Nimeuza leo');
    assert.equal(result.detectedLanguage, 'sw');
    assert.equal(result.modelVersion, 'whisper-1');
    assert.equal(result.segments?.length, 1);
    assert.equal(result.quality.durationSeconds, 6.2);
  });

  it('maps a client error to a non-retryable provider error', async () => {
    const fetchImpl = (async () => new Response('bad audio', { status: 400 })) as typeof fetch;
    const adapter = createOpenAiSpeechAdapter({
      storage: storageStub(async () => Buffer.from([0x01])),
      config: OPENAI,
      fetchImpl,
    });

    await assert.rejects(
      async () =>
        await adapter.transcribe({ businessId: 'biz', objectKey: 'obj', mediaType: 'audio/ogg', byteSize: 1, timezone: 'UTC' }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });
});

describe('OpenAI extraction adapter', () => {
  function completion(content: string): typeof fetch {
    return (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
  }

  const request = {
    businessId: 'biz',
    transcript: { text: 'Nimeuza leo kwa 50000', detectedLanguage: 'sw' },
    business: { currency: 'TZS', timezone: 'Africa/Dar_es_Salaam', nowIso: '2026-03-10T08:00:00.000Z' },
    customers: [],
    items: [],
    inventoryEnabled: false,
  };

  it('parses a valid proposal and stamps the schema and model version', async () => {
    const content = JSON.stringify({
      intent: 'sale',
      fields: { amountMinor: { value: 5000000, sourceSpan: '50000', confidence: 0.9 } },
      missingFields: [],
      ambiguities: [],
      clarificationRequired: false,
    });
    const adapter = createOpenAiExtractionAdapter({ config: OPENAI, fetchImpl: completion(content) });

    const proposal = await adapter.extract(request);

    assert.equal(proposal.schemaVersion, 'proposal-v1');
    assert.equal(proposal.intent, 'sale');
    assert.equal(proposal.modelVersion, 'gpt-4o-mini');
    assert.equal(proposal.fields.amountMinor?.value, 5000000);
  });

  it('clamps an out-of-range confidence instead of failing', async () => {
    const content = JSON.stringify({
      intent: 'sale',
      fields: { amountMinor: { value: 100, sourceSpan: '1', confidence: 3.5 } },
      missingFields: [],
      ambiguities: [],
    });
    const adapter = createOpenAiExtractionAdapter({ config: OPENAI, fetchImpl: completion(content) });
    const proposal = await adapter.extract(request);
    assert.equal(proposal.fields.amountMinor?.confidence, 1);
  });

  it('rejects an unknown intent', async () => {
    const content = JSON.stringify({ intent: 'bribe', fields: {}, missingFields: [], ambiguities: [] });
    const adapter = createOpenAiExtractionAdapter({ config: OPENAI, fetchImpl: completion(content) });

    await assert.rejects(
      async () => await adapter.extract(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.code, 'extraction_invalid');
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  it('rejects malformed JSON', async () => {
    const adapter = createOpenAiExtractionAdapter({ config: OPENAI, fetchImpl: completion('not json') });
    await assert.rejects(
      async () => await adapter.extract(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.code, 'extraction_invalid');
        return true;
      },
    );
  });
});

describe('signed media links', () => {
  const originalSecret = process.env.DAFTARI_MEDIA_SIGNING_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.DAFTARI_MEDIA_SIGNING_SECRET;
    else process.env.DAFTARI_MEDIA_SIGNING_SECRET = originalSecret;
  });

  it('issues interchangeable tokens across storage adapters', () => {
    process.env.DAFTARI_MEDIA_SIGNING_SECRET = 'unit-test-signing-secret';
    const s3 = createS3MediaStorage({
      bucket: 'bucket',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      endpoint: undefined,
      forcePathStyle: false,
      prefix: 'daftari-media',
      serverSideEncryption: undefined,
    });

    const link = s3.createSignedLink({ objectKey: 'obj_abc', ttlSeconds: 60 });
    // The local adapter verifies the S3-issued token, proving one shared scheme.
    const verified = localMediaStorage.verifySignedLink(link.token);
    assert.equal(verified?.objectKey, 'obj_abc');

    const tampered = `${link.token.slice(0, -2)}xx`;
    assert.equal(s3.verifySignedLink(tampered), null);
  });
});
