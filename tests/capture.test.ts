/**
 * In-app voice capture and draft reclassification.
 *
 * These pin the behaviours that keep the "extraction off" mode safe: a recording
 * is stored once and attributed to the signed-in user, a retried upload is not
 * stored twice, and a draft with no guessed type can only be reclassified by a
 * reviewer, never silently rewritten after it was decided.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, type Fixture } from './helpers/fixture';
import { get } from '@/server/db/client';
import { captureVoiceRecording } from '@/server/services/capture';
import { retypeDraftProposal } from '@/server/services/drafts';
import { processSourceEvent } from '@/server/services/pipeline';
import { mediaRetentionDeadline } from '@/server/services/media-acquisition';
import { overrideIntegrations } from '@/server/integrations';
import { manualDraftExtractionAdapter, MANUAL_DRAFT_PROVIDER } from '@/server/integrations/extraction/manual-draft-adapter';
import { createSyntheticVoiceNote } from '@/server/integrations/speech/synthetic-audio';
import { emptyProposalFields, PROPOSAL_SCHEMA_VERSION } from '@/lib/validation/proposal';
import {
  findMediaAssetBySourceEvent,
  findSourceEventByDedupeKey,
  insertMediaAsset,
  insertProposal,
  insertSourceEvent,
  proposalMissingFields,
} from '@/server/repositories/source.repository';
import type { AppError } from '@/lib/errors';
import type { ProposalState } from '@/server/domain/types';

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

let counter = 0;
function nextCaptureId(): string {
  counter += 1;
  return `cap_${counter}`;
}

const audio = (label = 'webm-audio') => Buffer.from(`fake-${label}-bytes`);

/** Inserts a draft the way the manual-draft adapter would leave it. */
async function createDraft(
  fixture: Fixture,
  overrides: { provider?: string; state?: ProposalState; recordType?: 'note' | 'sale' } = {},
) {
  const timestamp = '2026-03-10T08:00:00.000Z';
  const sourceEvent = await insertSourceEvent(fixture.db, {
    businessId: fixture.businessId,
    integrationId: null,
    providerEventId: nextCaptureId(),
    eventType: 'in_app_voice',
    senderRef: fixture.userId,
    receivedAt: timestamp,
    providerSentAt: timestamp,
    dedupeKey: `capture:${nextCaptureId()}`,
    redactedPayload: null,
  });
  return await insertProposal(fixture.db, {
    businessId: fixture.businessId,
    sourceEventId: sourceEvent.id,
    transcriptId: null,
    recordType: overrides.recordType ?? 'note',
    state: overrides.state ?? 'needs_details',
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    provider: overrides.provider ?? MANUAL_DRAFT_PROVIDER,
    modelVersion: 'capture-v1',
    fields: { ...emptyProposalFields('TZS'), note: 'Nimeuza bidhaa kwa 50000' },
    provenance: {},
    missingFields: ['recordType'],
    validationIssues: [],
    duplicateCandidates: [],
    ambiguityNote: null,
  });
}

describe('captureVoiceRecording', () => {
  it('stores the audio and attributes the recording to the signed-in user', async () => {
    const fixture = await createFixture();

    const result = await captureVoiceRecording(fixture.db, fixture.context, {
      captureId: nextCaptureId(),
      bytes: audio(),
      mediaType: 'audio/webm;codecs=opus',
      durationSeconds: 6,
    });

    assert.equal(result.deduped, false);
    assert.ok(result.mediaAssetId);

    const sourceEvent = await get<{ event_type: string; sender_ref: string; integration_id: string | null }>(
      fixture.db,
      'SELECT event_type, sender_ref, integration_id FROM source_events WHERE id = ?',
      [result.sourceEventId],
    );
    assert.equal(sourceEvent?.event_type, 'in_app_voice');
    assert.equal(sourceEvent?.sender_ref, fixture.userId);
    assert.equal(sourceEvent?.integration_id, null);

    const media = await findMediaAssetBySourceEvent(fixture.db, fixture.scope, result.sourceEventId);
    assert.equal(media?.media_type, 'audio/webm');
    assert.equal(media?.byte_size, audio().byteLength);
  });

  it('is idempotent: a retried upload reuses the source event instead of storing twice', async () => {
    const fixture = await createFixture();
    const captureId = nextCaptureId();
    const input = { captureId, bytes: audio(), mediaType: 'audio/webm', durationSeconds: 4 };

    const first = await captureVoiceRecording(fixture.db, fixture.context, input);
    const second = await captureVoiceRecording(fixture.db, fixture.context, input);

    assert.equal(second.deduped, true);
    assert.equal(second.sourceEventId, first.sourceEventId);
    assert.equal(second.mediaAssetId, null);

    const count = await get<{ count: number }>(
      fixture.db,
      'SELECT COUNT(*) AS count FROM media_assets WHERE business_id = ?',
      [fixture.businessId],
    );
    assert.equal(count?.count, 1);
  });

  it('rejects an empty recording', async () => {
    const fixture = await createFixture();

    await assert.rejects(
      async () =>
        await captureVoiceRecording(fixture.db, fixture.context, {
          captureId: nextCaptureId(),
          bytes: Buffer.alloc(0),
          mediaType: 'audio/webm',
          durationSeconds: null,
        }),
      (error: AppError) => error.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects an unsupported audio format', async () => {
    const fixture = await createFixture();

    await assert.rejects(
      async () =>
        await captureVoiceRecording(fixture.db, fixture.context, {
          captureId: nextCaptureId(),
          bytes: audio(),
          mediaType: 'application/pdf',
          durationSeconds: null,
        }),
      (error: AppError) => error.code === 'VALIDATION_FAILED',
    );
  });

  it('keeps two tenants apart even for the same capture id', async () => {
    const fixture = await createFixture();
    const captureId = nextCaptureId();

    const mine = await captureVoiceRecording(fixture.db, fixture.context, {
      captureId,
      bytes: audio(),
      mediaType: 'audio/webm',
      durationSeconds: 3,
    });
    const theirs = await captureVoiceRecording(fixture.db, fixture.other.context, {
      captureId,
      bytes: audio(),
      mediaType: 'audio/webm',
      durationSeconds: 3,
    });

    assert.notEqual(mine.sourceEventId, theirs.sourceEventId);
    assert.equal(
      (await findSourceEventByDedupeKey(fixture.db, fixture.scope, `capture:${captureId}`))?.id,
      mine.sourceEventId,
    );
    assert.equal(
      (await findSourceEventByDedupeKey(fixture.db, { businessId: fixture.other.businessId }, `capture:${captureId}`))?.id,
      theirs.sourceEventId,
    );
  });

  it('queues transcription instead of transcribing inline', async () => {
    const fixture = await createFixture();

    const result = await captureVoiceRecording(fixture.db, fixture.context, {
      captureId: nextCaptureId(),
      bytes: audio(),
      mediaType: 'audio/webm',
      durationSeconds: 5,
    });

    const job = await get<{ job_type: string; status: string }>(
      fixture.db,
      'SELECT job_type, status FROM jobs WHERE idempotency_key = ?',
      [`transcribe:${result.sourceEventId}`],
    );
    assert.equal(job?.job_type, 'transcribe_source');
    assert.equal(job?.status, 'pending');
  });
});

describe('retypeDraftProposal', () => {
  it('reclassifies an in-app draft and recomputes its missing fields', async () => {
    const fixture = await createFixture();
    const draft = await createDraft(fixture);

    const result = await retypeDraftProposal(fixture.db, fixture.context, {
      proposalId: draft.id,
      expectedVersion: draft.version,
      recordType: 'sale',
    });

    assert.equal(result.recordType, 'sale');
    assert.equal(result.state, 'needs_details');
    assert.deepEqual(result.missingFields, ['amountMinor', 'occurredAt', 'paymentStatus']);

    const stored = await get<{ record_type: string; state: string; missing_fields_json: string; version: number }>(
      fixture.db,
      'SELECT record_type, state, missing_fields_json, version FROM proposals WHERE id = ?',
      [draft.id],
    );
    assert.equal(stored?.record_type, 'sale');
    assert.equal(stored?.state, 'needs_details');
    assert.equal(stored?.version, draft.version + 1);
  });

  it('moves a draft to needs_review when the chosen type is already complete', async () => {
    const fixture = await createFixture();
    const draft = await createDraft(fixture);

    const result = await retypeDraftProposal(fixture.db, fixture.context, {
      proposalId: draft.id,
      expectedVersion: draft.version,
      recordType: 'note',
    });

    // The draft already carries a note, so nothing is missing.
    assert.equal(result.state, 'needs_review');
    assert.deepEqual(result.missingFields, []);
  });

  it('refuses to reclassify a proposal that came from a model', async () => {
    const fixture = await createFixture();
    const draft = await createDraft(fixture, { provider: 'mock-extraction' });

    await assert.rejects(
      async () =>
        await retypeDraftProposal(fixture.db, fixture.context, {
          proposalId: draft.id,
          expectedVersion: draft.version,
          recordType: 'sale',
        }),
      (error: AppError) => error.code === 'VALIDATION_FAILED',
    );
  });

  it('refuses a stale expected version', async () => {
    const fixture = await createFixture();
    const draft = await createDraft(fixture);

    await assert.rejects(
      async () =>
        await retypeDraftProposal(fixture.db, fixture.context, {
          proposalId: draft.id,
          expectedVersion: draft.version + 5,
          recordType: 'sale',
        }),
      (error: AppError) => error.code === 'PROPOSAL_VERSION_CONFLICT',
    );
  });

  it('refuses to reclassify a proposal that was already decided', async () => {
    const fixture = await createFixture();
    const draft = await createDraft(fixture, { state: 'confirmed' });

    await assert.rejects(
      async () =>
        await retypeDraftProposal(fixture.db, fixture.context, {
          proposalId: draft.id,
          expectedVersion: draft.version,
          recordType: 'sale',
        }),
      (error: AppError) => error.code === 'PROPOSAL_NOT_REVIEWABLE',
    );
  });

  it('cannot reach another tenant draft', async () => {
    const fixture = await createFixture();
    const draft = await createDraft(fixture);

    await assert.rejects(
      async () =>
        await retypeDraftProposal(fixture.db, fixture.other.context, {
          proposalId: draft.id,
          expectedVersion: draft.version,
          recordType: 'sale',
        }),
      (error: AppError) => error.status === 404,
    );
  });
});

describe('extraction off: an in-app recording becomes a draft to classify', () => {
  it('routes the recording to needs_details with no guessed type, then retypes it', async () => {
    const fixture = await createFixture();
    restores.push(overrideIntegrations({ extraction: manualDraftExtractionAdapter }));

    const stored = await createSyntheticVoiceNote({
      businessId: fixture.businessId,
      transcript: 'Nimeuza bidhaa zenye thamani ya 50000 kwa Mama Salma',
      language: 'sw',
    });
    const sourceEvent = await insertSourceEvent(fixture.db, {
      businessId: fixture.businessId,
      integrationId: null,
      providerEventId: nextCaptureId(),
      eventType: 'in_app_voice',
      senderRef: fixture.userId,
      receivedAt: '2026-03-10T08:00:00.000Z',
      providerSentAt: '2026-03-10T08:00:00.000Z',
      dedupeKey: `capture:${nextCaptureId()}`,
      redactedPayload: null,
    });
    await insertMediaAsset(fixture.db, {
      businessId: fixture.businessId,
      sourceEventId: sourceEvent.id,
      objectKey: stored.objectKey,
      mediaType: 'audio/wav',
      byteSize: stored.byteSize,
      durationSeconds: stored.durationSeconds,
      checksum: stored.checksum,
      retentionDeadline: mediaRetentionDeadline(fixture.context.retentionAudioDays),
    });

    const outcome = await processSourceEvent(fixture.db, fixture.context, sourceEvent.id);

    assert.equal(outcome.kind, 'proposal');
    if (outcome.kind !== 'proposal') return;
    assert.equal(outcome.proposal.record_type, 'note');
    assert.equal(outcome.proposal.provider, MANUAL_DRAFT_PROVIDER);
    assert.equal(outcome.proposal.state, 'needs_details');
    assert.deepEqual(proposalMissingFields(outcome.proposal), ['recordType']);

    const retyped = await retypeDraftProposal(fixture.db, fixture.context, {
      proposalId: outcome.proposal.id,
      expectedVersion: outcome.proposal.version,
      recordType: 'sale',
    });
    assert.equal(retyped.state, 'needs_details');
    assert.deepEqual(retyped.missingFields, ['amountMinor', 'occurredAt', 'paymentStatus']);
  });
});
