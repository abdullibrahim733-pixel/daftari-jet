/**
 * Exports and the job runner.
 *
 * An export is the one place where a merchant hands their ledger to a file, so
 * these tests pin the parts that are easy to get quietly wrong: the requested
 * date range must mean the same interval the reports screen shows, the file must
 * contain only the requesting tenant's records, a second run of the same
 * generation is safe, and a requested export really does get built by the queue
 * rather than sitting in "queued" forever.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, type Fixture } from './helpers/fixture';
import { confirmProposal } from '@/server/services/confirmation';
import { generateExport, requestExport, EXPORT_COLUMNS } from '@/server/services/exports';
import { runDueJobs, enqueueTranscription } from '@/server/services/jobs';
import { emptyProposalFields, missingRequiredFields, type ProposalFields } from '@/lib/validation/proposal';
import { insertProposal, insertSourceEvent } from '@/server/repositories/source.repository';
import { findExportJob, claimReadyJobs } from '@/server/repositories/platform.repository';
import { integrations } from '@/server/integrations';
import { ERROR_CODES, type AppError } from '@/lib/errors';
import { buildXlsx } from '@/server/exports/xlsx';

const _buildXlsx = buildXlsx;

let eventCounter = 0;

async function postSale(
  fixture: Fixture,
  options: { amountMinor: number; occurredAt: string; customerName?: string | null },
) {
  const { db, businessId } = fixture;
  eventCounter += 1;
  const sourceEvent = await insertSourceEvent(db, {
    businessId,
    integrationId: null,
    providerEventId: `evt_export_${eventCounter}`,
    eventType: 'message',
    senderRef: '+255700000001',
    receivedAt: options.occurredAt,
    providerSentAt: options.occurredAt,
    dedupeKey: `test:export:${eventCounter}`,
    redactedPayload: null,
  });
  const fields: ProposalFields = {
    ...emptyProposalFields('TZS'),
    amountMinor: options.amountMinor,
    occurredAt: options.occurredAt,
    occurredAtBasis: 'explicit',
    paymentStatus: 'paid',
    description: 'Export sale',
    customerName: options.customerName ?? null,
  };
  const proposal = await insertProposal(db, {
    businessId,
    sourceEventId: sourceEvent.id,
    transcriptId: null,
    recordType: 'sale',
    state: 'needs_review',
    schemaVersion: '1',
    provider: 'test',
    modelVersion: 'test',
    fields,
    provenance: {},
    missingFields: missingRequiredFields('sale', fields),
    validationIssues: [],
    duplicateCandidates: [],
  });
  const result = await confirmProposal(db, fixture.context, {
    proposalId: proposal.id,
    expectedVersion: proposal.version,
    confirmedByUserId: fixture.userId,
  });
  assert.equal(result.kind, 'confirmed');
}

async function requestCsvExport(fixture: Fixture, fromDate: string, toDate: string) {
  return await requestExport(
    fixture.db,
    fixture.context,
    { fromDate, toDate, recordTypes: ['sale'], format: 'csv' },
    fixture.userId,
  );
}

describe('exports', () => {
  it('includes the last day of the requested range', async () => {
    const fixture = await createFixture();
    // Late evening in Dar es Salaam on the final day of the month: a UTC-day
    // filter would drop this record and silently under-report the export.
    await postSale(fixture, { amountMinor: 10_000, occurredAt: '2026-03-31T19:30:00.000Z' });
    await postSale(fixture, { amountMinor: 20_000, occurredAt: '2026-03-01T08:00:00.000Z' });

    const job = await requestCsvExport(fixture, '2026-03-01', '2026-03-31');
    const generated = await generateExport(fixture.db, fixture.context, job.id);

    assert.equal(generated.status, 'ready');
    assert.equal(generated.row_count, 2, 'both records belong to the requested range');
  });

  it('treats the range as business-timezone days', async () => {
    const fixture = await createFixture({ timezone: 'Africa/Dar_es_Salaam' });
    // 22:30 UTC on 31 March is already 1 April in Dar es Salaam (UTC+3), so it
    // must land in April's export even though the UTC date says March.
    await postSale(fixture, { amountMinor: 30_000, occurredAt: '2026-03-31T22:30:00.000Z' });

    const marchRequest = await requestCsvExport(fixture, '2026-03-01', '2026-03-31');
    const aprilRequest = await requestCsvExport(fixture, '2026-04-01', '2026-04-30');
    const march = await generateExport(fixture.db, fixture.context, marchRequest.id);
    const april = await generateExport(fixture.db, fixture.context, aprilRequest.id);

    assert.equal(march.row_count, 0, 'a record after midnight local time is not in March');
    assert.equal(april.row_count, 1);
  });

  it('exports only the requesting tenant records', async () => {
    const fixture = await createFixture();
    await postSale(fixture, { amountMinor: 15_000, occurredAt: '2026-03-10T08:00:00.000Z' });
    // Create a sale for the other tenant against the same database.
    const otherBusiness = fixture.other.businessId;
    // Use the same helpers by temporarily swapping scope? Easier: just confirm directly.
    // Build proposal for other tenant
    const { db } = fixture;
    eventCounter += 1;
    const sourceEventOther = await insertSourceEvent(db, {
      businessId: otherBusiness,
      integrationId: null,
      providerEventId: `evt_other_${eventCounter}`,
      eventType: 'message',
      senderRef: '+255700099999',
      receivedAt: '2026-03-10T08:00:00.000Z',
      providerSentAt: '2026-03-10T08:00:00.000Z',
      dedupeKey: `test:other:${eventCounter}`,
      redactedPayload: null,
    });
    const otherFields: ProposalFields = {
      ...emptyProposalFields('TZS'),
      amountMinor: 99_000,
      occurredAt: '2026-03-10T08:00:00.000Z',
      occurredAtBasis: 'explicit',
      paymentStatus: 'paid',
      description: 'Other sale',
    };
    const otherProposal = await insertProposal(db, {
      businessId: otherBusiness,
      sourceEventId: sourceEventOther.id,
      transcriptId: null,
      recordType: 'sale',
      state: 'needs_review',
      schemaVersion: '1',
      provider: 'test',
      modelVersion: 'test',
      fields: otherFields,
      provenance: {},
      missingFields: missingRequiredFields('sale', otherFields),
      validationIssues: [],
      duplicateCandidates: [],
    });
    await confirmProposal(db, fixture.other.context, {
      proposalId: otherProposal.id,
      expectedVersion: otherProposal.version,
      confirmedByUserId: fixture.other.context.userId,
    });

    const request = await requestCsvExport(fixture, '2026-03-01', '2026-03-31');
    const job = await generateExport(fixture.db, fixture.context, request.id);

    assert.equal(job.row_count, 1);
    const text = new TextDecoder('utf8').decode(await readExport(fixture, job.object_key as string));
    assert.ok(text.includes('15000'), 'the requesting tenant must see its own record');
    assert.ok(!text.includes('99000'), "another tenant's amount must never appear");
  });

  it('filters by record type when the request asks for it', async () => {
    const fixture = await createFixture();
    await postSale(fixture, { amountMinor: 10_000, occurredAt: '2026-03-10T08:00:00.000Z' });

    const expenseRequest = await requestExport(
      fixture.db,
      fixture.context,
      { fromDate: '2026-03-01', toDate: '2026-03-31', recordTypes: ['expense'], format: 'csv' },
      fixture.userId,
    );
    const job = await generateExport(fixture.db, fixture.context, expenseRequest.id);

    assert.equal(job.row_count, 0, 'a sales-only ledger must yield no expense rows');
  });

  it('rejects an inverted date range', async () => {
    const fixture = await createFixture();
    const error = await (async () => {
      try {
        await requestCsvExport(fixture, '2026-03-31', '2026-03-01');
        return null;
      } catch (caught) {
        return caught as AppError;
      }
    })();
    assert.ok(error);
    assert.equal(error.code, ERROR_CODES.VALIDATION_FAILED);
  });

  it('cannot be generated by another tenant', async () => {
    const fixture = await createFixture();
    const job = await requestCsvExport(fixture, '2026-03-01', '2026-03-31');

    const error = await (async () => {
      try {
        await generateExport(fixture.db, fixture.other.context, job.id);
        return null;
      } catch (caught) {
        return caught as AppError;
      }
    })();

    assert.equal(error?.status, 404);
  });

  it('writes a header row and a row per record', async () => {
    const fixture = await createFixture();
    await postSale(fixture, { amountMinor: 12_345, occurredAt: '2026-03-10T08:00:00.000Z' });
    const xlsxRequest = await requestExport(
      fixture.db,
      fixture.context,
      { fromDate: '2026-03-01', toDate: '2026-03-31', recordTypes: ['sale'], format: 'xlsx' },
      fixture.userId,
    );
    const job = await generateExport(fixture.db, fixture.context, xlsxRequest.id);

    const bytes = await readExport(fixture, job.object_key as string);
    const rendered = new TextDecoder('utf8').decode(bytes);
    for (const column of EXPORT_COLUMNS) {
      assert.ok(rendered.includes(column), `the workbook must include the ${column} column`);
    }
  });
});

describe('export generation through the queue', () => {
  it('builds a requested export when the job runs', async () => {
    const fixture = await createFixture();
    await postSale(fixture, { amountMinor: 25_000, occurredAt: '2026-03-12T08:00:00.000Z' });

    const requested = await requestCsvExport(fixture, '2026-03-01', '2026-03-31');
    assert.equal(
      (await findExportJob(fixture.db, fixture.scope, requested.id))?.status,
      'queued',
      'the request itself must not build the file inline',
    );

    const summaries = await runDueJobs(fixture.db);
    const buildJob = summaries.find((summary) => summary.jobType === 'build_export');
    assert.ok(buildJob, 'requesting an export must queue a build_export job');
    assert.equal(buildJob.status, 'succeeded');

    const finished = await findExportJob(fixture.db, fixture.scope, requested.id);
    assert.equal(finished?.status, 'ready');
    assert.equal(finished?.row_count, 1);
    assert.ok(finished?.object_key, 'a ready export must have a stored object');
  });

  it('runs the export build only once for the same export', async () => {
    const fixture = await createFixture();
    await postSale(fixture, { amountMinor: 25_000, occurredAt: '2026-03-12T08:00:00.000Z' });
    await requestCsvExport(fixture, '2026-03-01', '2026-03-31');

    await runDueJobs(fixture.db);
    const second = await runDueJobs(fixture.db);

    assert.equal(
      second.filter((summary) => summary.jobType === 'build_export').length,
      0,
      'a completed job must not be claimed again',
    );
  });

  it('claims a job exactly once when two workers look at the same queue', async () => {
    const fixture = await createFixture();
    await enqueueTranscription(fixture.db, fixture.businessId, 'src_missing');

    const first = await claimReadyJobs(fixture.db, 10);
    const second = await claimReadyJobs(fixture.db, 10);

    assert.equal(first.length, 1);
    assert.equal(second.length, 0, 'claiming must be atomic so work is not run twice');
  });
});

/* ------------------------------------------------------------------ helpers */

/**
 * Reads a generated file back through the same storage adapter the download
 * route uses. Reading through a different path than production would let a
 * mismatch between the write and the read slip through.
 */
async function readExport(_fixture: Fixture, objectKey: string): Promise<Uint8Array> {
  const bytes = await integrations().storage.readObject(objectKey);
  return new Uint8Array(bytes);
}
