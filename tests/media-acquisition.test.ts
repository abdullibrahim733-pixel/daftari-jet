/**
 * Provider-media acquisition.
 *
 * A real provider only hands over a media reference, so ingestion must queue a
 * download and the download must complete before transcription can see an empty
 * transcript. These tests pin that ordering and the per-event idempotency.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, type Fixture } from './helpers/fixture';
import { ingestWhatsAppDelivery } from '@/server/services/ingestion';
import { acquireMediaForSourceEvent } from '@/server/services/media-acquisition';
import { runDueJobs } from '@/server/services/jobs';
import { overrideIntegrations } from '@/server/integrations';
import { computeTwilioSignature, createTwilioWhatsAppAdapter } from '@/server/integrations/whatsapp/twilio-whatsapp-adapter';
import { upsertIntegration } from '@/server/repositories/business.repository';
import { listRecentJobs } from '@/server/repositories/platform.repository';
import { findMediaAssetBySourceEvent, findSourceEventById } from '@/server/repositories/source.repository';

const TWILIO = { accountSid: 'ACxxxxxxxx', authToken: 'twilio-auth-token', fromNumber: '+255700000001' };
const URL = 'https://shop.example.com/api/v1/webhooks/whatsapp';

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function twilioDelivery(params: Record<string, string>) {
  const rawBody = new URLSearchParams(params).toString();
  const signature = computeTwilioSignature(TWILIO.authToken, URL, Object.fromEntries(new URLSearchParams(rawBody)));
  return { rawBody, signature, timestamp: null, url: URL, contentType: 'application/x-www-form-urlencoded' };
}

function voiceParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SM_1',
    From: 'whatsapp:+255711111111',
    To: 'whatsapp:+255700000001',
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC/media/ME',
    MediaContentType0: 'audio/ogg',
    ...overrides,
  };
}

async function connectTwilio(fixture: Fixture): Promise<void> {
  await upsertIntegration(fixture.db, {
    businessId: fixture.businessId,
    provider: 'whatsapp',
    externalAccountRef: '+255700000001',
    status: 'connected',
    scopes: ['messages'],
  });
}

describe('provider media acquisition', () => {
  it('queues a download (not transcription), then stores the media and queues transcription', async () => {
    const fixture = await createFixture();
    await connectTwilio(fixture);

    let downloads = 0;
    const fetchImpl = (async () => {
      downloads += 1;
      return new Response(new Uint8Array([0xff, 0xfb, 0x00]), {
        status: 200,
        headers: { 'content-type': 'audio/ogg' },
      });
    }) as typeof fetch;
    restores.push(overrideIntegrations({ whatsapp: createTwilioWhatsAppAdapter(TWILIO, { fetchImpl }) }));

    const result = await ingestWhatsAppDelivery(fixture.db, twilioDelivery(voiceParams()));

    const sourceEvent = await findSourceEventById(fixture.db, fixture.scope, result.sourceEventId);
    assert.equal(sourceEvent?.event_type, 'whatsapp_voice');
    const payload = JSON.parse(sourceEvent?.payload_redacted ?? '{}');
    assert.equal(payload.mediaRef, 'https://api.twilio.com/2010-04-01/Accounts/AC/media/ME');

    // Nothing downloaded at webhook time; only the acquire job is queued.
    assert.equal(downloads, 0);
    assert.equal(await findMediaAssetBySourceEvent(fixture.db, fixture.scope, result.sourceEventId), undefined);
    let jobTypes = (await listRecentJobs(fixture.db, fixture.scope)).map((job) => job.job_type);
    assert.deepEqual(jobTypes, ['acquire_media']);

    const summaries = await runDueJobs(fixture.db, { limit: 10 });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.jobType, 'acquire_media');
    assert.equal(summaries[0]?.status, 'succeeded');
    assert.equal(downloads, 1);

    const media = await findMediaAssetBySourceEvent(fixture.db, fixture.scope, result.sourceEventId);
    assert.ok(media);
    assert.equal(media.media_type, 'audio/ogg');
    assert.equal(media.byte_size, 3);

    jobTypes = (await listRecentJobs(fixture.db, fixture.scope)).map((job) => job.job_type);
    assert.deepEqual([...jobTypes].sort(), ['acquire_media', 'transcribe_source']);
  });

  it('is idempotent: a retried acquisition reuses the stored object', async () => {
    const fixture = await createFixture();
    await connectTwilio(fixture);

    let downloads = 0;
    const fetchImpl = (async () => {
      downloads += 1;
      return new Response(new Uint8Array([0xff, 0xfb]), { status: 200, headers: { 'content-type': 'audio/ogg' } });
    }) as typeof fetch;
    restores.push(overrideIntegrations({ whatsapp: createTwilioWhatsAppAdapter(TWILIO, { fetchImpl }) }));

    const result = await ingestWhatsAppDelivery(fixture.db, twilioDelivery(voiceParams()));
    await runDueJobs(fixture.db, { limit: 10 });
    assert.equal(downloads, 1);

    const second = await acquireMediaForSourceEvent(fixture.db, fixture.context, result.sourceEventId);
    assert.equal(second.kind, 'already_acquired');
    assert.equal(downloads, 1, 'a retry must not download again');
  });

  it('fails cleanly when the provider download fails', async () => {
    const fixture = await createFixture();
    await connectTwilio(fixture);

    const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    restores.push(overrideIntegrations({ whatsapp: createTwilioWhatsAppAdapter(TWILIO, { fetchImpl }) }));

    const result = await ingestWhatsAppDelivery(fixture.db, twilioDelivery(voiceParams()));
    const summaries = await runDueJobs(fixture.db, { limit: 10 });

    assert.equal(summaries[0]?.status, 'failed');
    assert.equal(summaries[0]?.errorCode, 'media_download_failed');
    assert.equal(await findMediaAssetBySourceEvent(fixture.db, fixture.scope, result.sourceEventId), undefined);
  });
});
