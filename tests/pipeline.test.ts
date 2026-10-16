/**
 * Intake pipeline: signed delivery -> source event -> transcript -> proposal.
 *
 * The behaviours pinned here are the ones that would quietly corrupt the
 * review queue: an unsigned delivery must never be stored, a redelivered
 * provider event must not create a second message, a retried transcription must
 * not pile up failed transcripts, and nothing from one tenant may surface in
 * another's queue.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, type Fixture } from './helpers/fixture';
import { get } from '@/server/db/client';
import { ingestWhatsAppDelivery } from '@/server/services/ingestion';
import { processSourceEvent, proposalFieldsFromProposal } from '@/server/services/pipeline';
import { overrideIntegrations } from '@/server/integrations';
import { createSyntheticVoiceNote } from '@/server/integrations/speech/synthetic-audio';
import { ProviderError, type SpeechAdapter } from '@/server/integrations/speech/port';
import { signLocalWebhook } from '@/server/integrations/whatsapp/local-whatsapp-adapter';
import { upsertIntegration } from '@/server/repositories/business.repository';
import {
  PROPOSAL_SCHEMA_VERSION,
  type ExtractionProposal,
  type FieldProvenance,
} from '@/lib/validation/proposal';
import {
  countOpenProposals,
  countProposalsByState,
  findProposalBySourceEvent,
  findSourceEventById,
  findTranscriptBySourceEvent,
  listProposals,
  proposalFields,
} from '@/server/repositories/source.repository';
import type { AppError } from '@/lib/errors';

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

let mediaCounter = 0;

async function connectAccount(fixture: Fixture, accountRef = '+255700000001') {
  return await upsertIntegration(fixture.db, {
    businessId: fixture.businessId,
    provider: 'whatsapp',
    externalAccountRef: accountRef,
    status: 'connected',
    scopes: ['messages'],
    consentGivenAt: '2026-03-10T08:00:00.000Z',
  });
}

function delivery(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const timestamp = '1773148800';
  return { rawBody, timestamp, signature: signLocalWebhook(rawBody, timestamp) };
}

/**
 * Builds an inbound voice message backed by a real stored voice note, because
 * transcription reads the audio from private storage before it can work.
 */
async function inbound(overrides: Record<string, unknown> = {}) {
  mediaCounter += 1;
  const stored = await createSyntheticVoiceNote({
    businessId: 'test-business',
    // Sale, date and payment status all stated, so the proposal is complete
    // enough to reach the review queue without a follow-up question.
    transcript: 'Nimeuza leo bidhaa zenye thamani ya 50000 na ameiliwa',
    language: 'sw',
  });
  return {
    eventId: `evt_${mediaCounter}`,
    accountRef: '+255700000001',
    kind: 'voice',
    senderRef: '+255711111111',
    senderName: 'Joseph',
    providerSentAt: '2026-03-10T08:00:00.000Z',
    media: {
      objectKey: stored.objectKey,
      mediaType: 'audio/wav',
      byteSize: stored.byteSize,
      checksum: stored.checksum,
      durationSeconds: stored.durationSeconds,
    },
    ...overrides,
  };
}

describe('ingestWhatsAppDelivery', () => {
  it('stores a signed delivery and attributes it to the connected tenant', async () => {
    const fixture = await createFixture();
    await connectAccount(fixture);

    const result = await ingestWhatsAppDelivery(fixture.db, delivery(await inbound()));

    assert.equal(result.businessId, fixture.businessId);
    assert.equal(result.deduped, false);
    assert.equal(result.context.businessId, fixture.businessId);

    const stored = await findSourceEventById(fixture.db, fixture.scope, result.sourceEventId);
    assert.equal(stored?.status, 'received');
    assert.equal(stored?.sender_ref, '+255711111111');
  });

  it('rejects an unsigned delivery', async () => {
    const fixture = await createFixture();
    await connectAccount(fixture);
    const rawBody = JSON.stringify(await inbound());

    await assert.rejects(
      async () =>
        await ingestWhatsAppDelivery(fixture.db, {
          rawBody,
          signature: `sha256=${'0'.repeat(64)}`,
          timestamp: '1773148800',
        }),
      (error: AppError) => error.code === 'SIGNATURE_INVALID' && error.status === 401,
    );
  });

  it('rejects a delivery for an account nobody connected', async () => {
    const fixture = await createFixture();
    const body = delivery(await inbound());

    await assert.rejects(
      async () => await ingestWhatsAppDelivery(fixture.db, body),
      (error: AppError) => error.status === 404,
    );
  });

  it('rejects a delivery while the integration is disconnected', async () => {
    const fixture = await createFixture();
    await upsertIntegration(fixture.db, {
      businessId: fixture.businessId,
      provider: 'whatsapp',
      externalAccountRef: '+255700000001',
      status: 'disconnected',
      scopes: ['messages'],
    });

    const body = delivery(await inbound());

    await assert.rejects(
      async () => await ingestWhatsAppDelivery(fixture.db, body),
      (error: AppError) => error.code === 'INTEGRATION_NOT_CONNECTED',
    );
  });

  it('treats a provider redelivery as the same message', async () => {
    const fixture = await createFixture();
    await connectAccount(fixture);
    const body = await inbound();

    const first = await ingestWhatsAppDelivery(fixture.db, delivery(body));
    const second = await ingestWhatsAppDelivery(fixture.db, delivery(body));

    assert.equal(second.deduped, true);
    assert.equal(second.sourceEventId, first.sourceEventId);
  });

  it('keeps two businesses on the same provider separate', async () => {
    const fixture = await createFixture();
    await connectAccount(fixture);
    await upsertIntegration(fixture.db, {
      businessId: fixture.other.businessId,
      provider: 'whatsapp',
      externalAccountRef: '+255700000002',
      status: 'connected',
      scopes: ['messages'],
    });

    const mine = await ingestWhatsAppDelivery(fixture.db, delivery(await inbound()));
    const theirs = await ingestWhatsAppDelivery(
      fixture.db,
      delivery(await inbound({ accountRef: '+255700000002' })),
    );

    assert.equal(mine.businessId, fixture.businessId);
    assert.equal(theirs.businessId, fixture.other.businessId);
    assert.notEqual(mine.sourceEventId, theirs.sourceEventId);
  });

  it('accepts a text message with no media at all', async () => {
    const fixture = await createFixture();
    await connectAccount(fixture);

    const result = await ingestWhatsAppDelivery(
      fixture.db,
      delivery(await inbound({ kind: 'text', text: 'Mama Salma ameiliwa pesa 50000', media: undefined })),
    );

    assert.ok(result.sourceEventId);
  });
});

describe('processSourceEvent', () => {
  async function ingestAndProcess(fixture: Fixture, overrides = {}) {
    await connectAccount(fixture);
    const ingested = await ingestWhatsAppDelivery(fixture.db, delivery(await inbound(overrides)));
    const outcome = await processSourceEvent(fixture.db, fixture.context, ingested.sourceEventId);
    return { ingested, outcome };
  }

  it('turns a message into exactly one reviewable proposal', async () => {
    const fixture = await createFixture();

    const { ingested, outcome } = await ingestAndProcess(fixture);

    assert.equal(outcome.kind, 'proposal');
    if (outcome.kind !== 'proposal') return;
    assert.equal(outcome.proposal.state, 'needs_review');
    assert.equal(outcome.proposal.business_id, fixture.businessId);
    assert.equal(outcome.proposal.source_event_id, ingested.sourceEventId);
    assert.equal(await countOpenProposals(fixture.db, fixture.scope), 1);
  });

  it('marks the source event processed and links the transcript', async () => {
    const fixture = await createFixture();

    const { ingested, outcome } = await ingestAndProcess(fixture);

    assert.equal((await findSourceEventById(fixture.db, fixture.scope, ingested.sourceEventId))?.status, 'processed');
    assert.ok(outcome.kind === 'proposal' && outcome.proposal.transcript_id);
    const transcript = await findTranscriptBySourceEvent(fixture.db, fixture.scope, ingested.sourceEventId);
    assert.equal(transcript?.status, 'ready');
    assert.ok(transcript && transcript.machine_text.length > 0);
  });

  it('creates no second proposal when the same event is processed again', async () => {
    const fixture = await createFixture();
    const { ingested } = await ingestAndProcess(fixture);

    const second = await processSourceEvent(fixture.db, fixture.context, ingested.sourceEventId);

    assert.equal(second.kind, 'skipped');
    assert.equal(await countOpenProposals(fixture.db, fixture.scope), 1);
  });

  it('reports a missing source event instead of throwing', async () => {
    const fixture = await createFixture();

    const outcome = await processSourceEvent(fixture.db, fixture.context, 'src_nope');

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(outcome.failureCode, 'source_event_not_found');
    assert.equal(outcome.retryable, false);
  });

  it('records a retryable transcription failure without creating a proposal', async () => {
    const fixture = await createFixture();
    await connectAccount(fixture);
    const ingested = await ingestWhatsAppDelivery(fixture.db, delivery(await inbound()));
    restores.push(
      overrideIntegrations({
        speech: {
          name: 'always-fails',
          async transcribe() {
            throw new ProviderError('provider_timeout', 'transcription timed out', true);
          },
        } satisfies SpeechAdapter,
      }),
    );

    const outcome = await processSourceEvent(fixture.db, fixture.context, ingested.sourceEventId);

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(outcome.failureCode, 'provider_timeout');
    assert.equal(outcome.retryable, true);
    assert.equal(
      (await findSourceEventById(fixture.db, fixture.scope, ingested.sourceEventId))?.status,
      'failed',
    );
    assert.equal(await countOpenProposals(fixture.db, fixture.scope), 0);
  });

  it('keeps exactly one failed transcript across repeated retries', async () => {
    const fixture = await createFixture();
    await connectAccount(fixture);
    const ingested = await ingestWhatsAppDelivery(fixture.db, delivery(await inbound()));
    restores.push(
      overrideIntegrations({
        speech: {
          name: 'always-fails',
          async transcribe() {
            throw new ProviderError('provider_timeout', 'transcription timed out', true);
          },
        } satisfies SpeechAdapter,
      }),
    );

    await processSourceEvent(fixture.db, fixture.context, ingested.sourceEventId);
    await processSourceEvent(fixture.db, fixture.context, ingested.sourceEventId);
    await processSourceEvent(fixture.db, fixture.context, ingested.sourceEventId);

    const rows = await get<{ count: number }>(
      fixture.db,
      'SELECT COUNT(*) AS count FROM transcripts WHERE source_event_id = ?',
      [ingested.sourceEventId],
    );
    assert.equal(rows?.count ?? 0, 1, 'a retried transcription must not pile up transcript rows');
  });

  it('reaches a proposal once the provider recovers', async () => {
    const fixture = await createFixture();
    await connectAccount(fixture);
    const ingested = await ingestWhatsAppDelivery(fixture.db, delivery(await inbound()));
    restores.push(
      overrideIntegrations({
        speech: {
          name: 'always-fails',
          async transcribe() {
            throw new ProviderError('provider_unavailable', 'down', true);
          },
        } satisfies SpeechAdapter,
      }),
    );
    await processSourceEvent(fixture.db, fixture.context, ingested.sourceEventId);

    restores.pop()?.();
    const outcome = await processSourceEvent(fixture.db, fixture.context, ingested.sourceEventId);

    assert.equal(outcome.kind, 'proposal');
  });

  it('does not treat a permanent provider error as retryable', async () => {
    const fixture = await createFixture();
    await connectAccount(fixture);
    const ingested = await ingestWhatsAppDelivery(fixture.db, delivery(await inbound()));
    restores.push(
      overrideIntegrations({
        speech: {
          name: 'rejects-audio',
          async transcribe() {
            throw new ProviderError('unsupported_media', 'cannot read this codec', false);
          },
        } satisfies SpeechAdapter,
      }),
    );

    const outcome = await processSourceEvent(fixture.db, fixture.context, ingested.sourceEventId);

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(outcome.retryable, false);
  });

  it('never exposes another tenant\'s proposal', async () => {
    const fixture = await createFixture();
    const { ingested } = await ingestAndProcess(fixture);

    const foreign = await listProposals(fixture.db, { businessId: fixture.other.businessId }, {
      states: ['needs_review', 'needs_details', 'duplicate'],
      limit: 20,
      order: 'oldest_first',
    });

    assert.equal(foreign.length, 0);
    assert.equal(
      await findProposalBySourceEvent(fixture.db, { businessId: fixture.other.businessId }, ingested.sourceEventId),
      undefined,
    );
  });

  it('counts queue entries per tenant', async () => {
    const fixture = await createFixture();
    await ingestAndProcess(fixture);
    await ingestAndProcess(fixture);

    assert.equal((await countProposalsByState(fixture.db, fixture.scope)).needs_review, 2);
    assert.deepEqual(await countProposalsByState(fixture.db, { businessId: fixture.other.businessId }), {});
  });
});

describe('proposalFieldsFromProposal', () => {
  const field = (value: FieldProvenance['value'], sourceSpan: string, confidence = 0.9): FieldProvenance => ({
    value,
    sourceSpan,
    confidence,
  });

  function proposal(fields: Record<string, FieldProvenance>, overrides: Partial<ExtractionProposal> = {}): ExtractionProposal {
    return {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      intent: 'sale',
      fields,
      missingFields: [],
      ambiguities: [],
      modelVersion: 'test-1',
      ...overrides,
    };
  }

  it('normalizes model fields and records provenance per field', () => {
    const { fields, provenance } = proposalFieldsFromProposal(
      proposal({
        amountMinor: field(50_000, '50000'),
        occurredAt: field('2026-03-10T08:00:00.000Z', '10/3/2026'),
        customerName: field('Mama Salma', 'Mama Salma'),
        paymentStatus: field('unpaid', 'deni'),
      }),
      'TZS',
    );

    assert.equal(fields.amountMinor, 50_000);
    assert.equal(fields.customerName, 'Mama Salma');
    assert.equal(fields.paymentStatus, 'unpaid');
    assert.equal(fields.occurredAtBasis, 'explicit');
    assert.equal(provenance.amountMinor?.confidence, 0.9);
  });

  it('marks a relative date by the words the merchant used', () => {
    const today = proposalFieldsFromProposal(
      proposal({ occurredAt: field('2026-03-10T08:00:00.000Z', 'leo') }),
      'TZS',
    );
    const yesterday = proposalFieldsFromProposal(
      proposal({ occurredAt: field('2026-03-09T08:00:00.000Z', 'jana') }),
      'TZS',
    );

    assert.equal(today.fields.occurredAtBasis, 'today');
    assert.equal(yesterday.fields.occurredAtBasis, 'yesterday');
  });

  it('carries an extracted part payment through to the reviewer', () => {
    const { fields } = proposalFieldsFromProposal(
      proposal({
        amountMinor: field(50_000, '50000'),
        amountPaidMinor: field(20_000, 'alilipa 20000'),
        paymentStatus: field('partial', 'partial'),
      }),
      'TZS',
    );

    assert.equal(fields.amountPaidMinor, 20_000);
  });

  it('ignores an unparseable amount instead of storing NaN', () => {
    const { fields } = proposalFieldsFromProposal(
      proposal({ amountMinor: field('many', 'many') }),
      'TZS',
    );

    assert.equal(fields.amountMinor, null);
  });

  it('never lets the model change the business currency', () => {
    const { fields } = proposalFieldsFromProposal(
      proposal({ amountMinor: field(50_000, '50000') }, { intent: 'sale' }),
      'TZS',
    );

    assert.equal(fields.currency, 'TZS');
  });

  it('keeps unknown model keys visible in provenance instead of dropping them', () => {
    const { fields, provenance } = proposalFieldsFromProposal(
      proposal({ amountMinor: field(50_000, '50000'), mysteryField: field('x', 'x') }),
      'TZS',
    );

    assert.equal(fields.amountMinor, 50_000);
    assert.ok('mysteryField' in provenance);
  });
});

describe('queue ordering', () => {
  it('returns the oldest review item first so nothing is starved', async () => {
    const fixture = await createFixture();
    await connectAccount(fixture);
    for (let index = 0; index < 2; index += 1) {
      const ingested = await ingestWhatsAppDelivery(fixture.db, delivery(await inbound()));
      await processSourceEvent(fixture.db, fixture.context, ingested.sourceEventId);
    }

    const queue = await listProposals(fixture.db, fixture.scope, {
      states: ['needs_review'],
      limit: 10,
      order: 'oldest_first',
    });

    assert.equal(queue.length, 2);
    const [oldest, newest] = queue;
    assert.ok(oldest && newest, 'the queue must contain both proposals');
    assert.ok(oldest.created_at <= newest.created_at);
    assert.ok(proposalFields(oldest).amountMinor !== null);
  });
});
