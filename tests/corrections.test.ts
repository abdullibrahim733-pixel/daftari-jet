/**
 * Corrections and reversals.
 *
 * These tests pin the promises that make corrections safe to offer a merchant:
 * nothing is silently overwritten, deni follows a corrected amount, money that
 * was already applied to a debt cannot be un-applied by an edit, a reversal
 * removes the record from every derived total, and one tenant can never touch
 * another tenant's record.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, type Fixture } from './helpers/fixture';
import { confirmProposal } from '@/server/services/confirmation';
import { applyCorrection, recordHistory } from '@/server/services/corrections';
import { ERROR_CODES, type AppError } from '@/lib/errors';
import { emptyProposalFields, missingRequiredFields, type ProposalFields } from '@/lib/validation/proposal';
import {
  insertProposal,
  insertSourceEvent,
  type ProposalRow,
} from '@/server/repositories/source.repository';
import {
  findLedgerRecordById,
  periodTotals,
} from '@/server/repositories/ledger.repository';
import {
  customerBalances,
  findCustomerByName,
  listCustomers,
  listObligationsForCustomer,
  listObligationsForRecord,
} from '@/server/repositories/debt.repository';
import { createItem } from '@/server/repositories/inventory.repository';
import { cashSummary } from '@/server/services/reports';
import { dateRangeToUtcMs } from '@/lib/formatting/datetime';

let eventCounter = 0;

type SeedOverrides = Partial<ProposalFields> & { recordType?: ProposalRow['record_type'] };

async function seedProposal(fixture: Fixture, overrides: SeedOverrides = {}): Promise<ProposalRow> {
  const { db, businessId } = fixture;
  eventCounter += 1;
  const sourceEvent = await insertSourceEvent(db, {
    businessId,
    integrationId: null,
    providerEventId: `evt_corr_${eventCounter}`,
    eventType: 'message',
    senderRef: '+255700000001',
    receivedAt: '2026-03-10T08:00:00.000Z',
    providerSentAt: '2026-03-10T08:00:00.000Z',
    dedupeKey: `test:correction:${eventCounter}`,
    redactedPayload: null,
  });

  const recordType = overrides.recordType ?? 'sale';
  const fields: ProposalFields = {
    ...emptyProposalFields('TZS'),
    amountMinor: 50_000,
    occurredAt: '2026-03-10T08:00:00.000Z',
    occurredAtBasis: 'explicit',
    paymentStatus: 'paid',
    description: 'Test sale',
    ...overrides,
  };

  return await insertProposal(db, {
    businessId,
    sourceEventId: sourceEvent.id,
    transcriptId: null,
    recordType,
    state: 'needs_review',
    schemaVersion: '1',
    provider: 'test',
    modelVersion: 'test',
    fields,
    provenance: {},
    missingFields: missingRequiredFields(recordType, fields),
    validationIssues: [],
    duplicateCandidates: [],
  });
}

async function confirm(fixture: Fixture, proposal: ProposalRow, fields?: Partial<ProposalFields>) {
  const result = await confirmProposal(fixture.db, fixture.context, {
    proposalId: proposal.id,
    expectedVersion: proposal.version,
    confirmedByUserId: fixture.userId,
    fields,
  });
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') throw new Error('expected a confirmed record');
  return result;
}

async function correct(
  fixture: Fixture,
  recordId: string,
  expectedVersion: number,
  fields: Partial<ProposalFields>,
  reasonCode = 'wrong_amount',
) {
  return await applyCorrection(fixture.db, fixture.context, {
    recordId,
    expectedVersion,
    action: 'correct',
    reasonCode,
    reasonNote: 'Corrected during review',
    fields,
    actorUserId: fixture.userId,
  });
}

async function reverse(fixture: Fixture, recordId: string, expectedVersion: number, reasonCode = 'recorded_in_error') {
  return await applyCorrection(fixture.db, fixture.context, {
    recordId,
    expectedVersion,
    action: 'reverse',
    reasonCode,
    reasonNote: 'Recorded in error',
    actorUserId: fixture.userId,
  });
}

const range = { from: '2026-03-01', toExclusive: '2026-04-01' };

describe('applyCorrection: correcting fields', () => {
  it('restates the amount and keeps the previous snapshot in the version history', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, { customerName: null });
    const { record } = await confirm(fixture, proposal);

    const result = await correct(fixture, record.id, record.version, { amountMinor: 65_000 });

    assert.equal(result.record.amount_minor, 65_000);
    assert.equal(result.record.version, 2, 'a correction must bump the version');

    const history = await recordHistory(fixture.db, fixture.context, record.id);
    const corrected = history.find((entry) => entry.changeKind === 'corrected');
    assert.ok(corrected, 'the correction must be recorded in the version history');
    assert.equal(
      corrected.snapshot.amountMinor,
      50_000,
      'the previous amount must remain readable',
    );
    assert.equal(corrected.reasonCode, 'wrong_amount');
    assert.equal(corrected.actorName, 'Test Owner');
    assert.equal(history[0]?.changeKind, 'created', 'the original version is kept too');
  });

  it('restates deni when a corrected amount changes what the customer owes', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, { customerName: 'Mama Salma', paymentStatus: 'unpaid' });
    const { record } = await confirm(fixture, proposal);
    const customer = await findCustomerByName(fixture.db, fixture.scope, 'Mama Salma');
    assert.ok(customer);

    await correct(fixture, record.id, record.version, { amountMinor: 80_000 });

    const [obligation] = await listObligationsForCustomer(fixture.db, fixture.scope, customer.id);
    assert.equal(obligation?.original_amount_minor, 80_000, 'deni must follow the corrected amount');
    assert.equal((await customerBalances(fixture.db, fixture.scope, '2026-03-31'))[0]?.balanceMinor, 80_000);
  });

  it('settles deni when a correction leaves nothing owed', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, { customerName: 'Mama Salma', paymentStatus: 'unpaid' });
    const { record } = await confirm(fixture, proposal);
    const customer = await findCustomerByName(fixture.db, fixture.scope, 'Mama Salma');
    assert.ok(customer);

    await correct(fixture, record.id, record.version, { paymentStatus: 'paid' });

    const [obligation] = await listObligationsForCustomer(fixture.db, fixture.scope, customer.id);
    assert.equal(obligation?.state, 'settled');
    assert.equal(
      (await customerBalances(fixture.db, fixture.scope, '2026-03-31')).length,
      0,
      'a settled customer must disappear from the owing list',
    );
  });

  it('opens deni when a correction turns a paid sale into an unpaid one', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, { customerName: null, paymentStatus: 'paid' });
    const { record } = await confirm(fixture, proposal);
    assert.equal(
      (await listCustomers(fixture.db, fixture.scope)).length,
      0,
      'a fully paid sale stays customer-less, so there is no debt to correct yet',
    );

    await correct(fixture, record.id, record.version, {
      paymentStatus: 'unpaid',
      customerName: 'Mama Salma',
    });

    const customer = await findCustomerByName(fixture.db, fixture.scope, 'Mama Salma');
    assert.ok(customer, 'the correction must be able to name who now owes the money');
    const [obligation] = await listObligationsForCustomer(fixture.db, fixture.scope, customer.id);
    assert.equal(obligation?.original_amount_minor, 50_000);
  });

  it('refuses to reduce a debt below the payments already applied to it', async () => {
    const fixture = await createFixture();
    const sale = await seedProposal(fixture, { customerName: 'Mama Salma', paymentStatus: 'unpaid' });
    const { record: saleRecord } = await confirm(fixture, sale);
    const payment = await seedProposal(fixture, {
      recordType: 'debt_payment',
      customerName: 'Mama Salma',
      amountMinor: 40_000,
      paymentStatus: 'paid',
    });
    await confirm(fixture, payment);

    const current = await findLedgerRecordById(fixture.db, fixture.scope, saleRecord.id);
    assert.ok(current);
    const error = await (async () => {
      try {
        await correct(fixture, saleRecord.id, current.version, { amountMinor: 10_000 });
        return null;
      } catch (caught) {
        return caught as AppError;
      }
    })();

    assert.ok(error, 'the correction must be refused');
    assert.equal(error.code, ERROR_CODES.OBLIGATION_HAS_PAYMENTS);
    assert.equal(error.status, 409);
    const [obligation] = await listObligationsForCustomer(
      fixture.db,
      fixture.scope,
      (await findCustomerByName(fixture.db, fixture.scope, 'Mama Salma'))!.id,
    );
    assert.equal(
      obligation?.original_amount_minor,
      50_000,
      'a refused correction must not change anything',
    );
  });

  it('rejects a stale expected version instead of overwriting a newer change', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture);
    const { record } = await confirm(fixture, proposal);
    await correct(fixture, record.id, record.version, { amountMinor: 60_000 });

    const error = await (async () => {
      try {
        // A second reviewer still holds version 1 and tries to write their own.
        await correct(fixture, record.id, record.version, { amountMinor: 70_000 });
        return null;
      } catch (caught) {
        return caught as AppError;
      }
    })();

    assert.equal(error?.code, ERROR_CODES.RECORD_VERSION_CONFLICT);
    const current = await findLedgerRecordById(fixture.db, fixture.scope, record.id);
    assert.equal(current?.amount_minor, 60_000, 'the second correction must not be applied');
    assert.equal(current?.version, 2);
  });

  it('reports validation issues without writing anything', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture);
    const { record } = await confirm(fixture, proposal);

    const result = await applyCorrection(fixture.db, fixture.context, {
      recordId: record.id,
      expectedVersion: record.version,
      action: 'correct',
      reasonCode: 'wrong_amount',
      fields: { amountMinor: -5_000 },
      actorUserId: fixture.userId,
    });

    assert.ok(result.issues, 'an invalid correction returns issues instead of throwing');
    assert.ok(result.issues.length > 0);
    const current = await findLedgerRecordById(fixture.db, fixture.scope, record.id);
    assert.equal(current?.version, 1, 'nothing may be written for an invalid correction');
    assert.equal(current?.amount_minor, 50_000);
  });

  it('refuses fields that are not correctable on a posted record', async () => {
    const fixture = await createFixture({ features: { inventory: true } });
    await createItem(fixture.db, fixture.scope, { name: 'Rice', unit: 'kg' });
    const proposal = await seedProposal(fixture, {
      recordType: 'stock_movement',
      amountMinor: null,
      paymentStatus: null,
      quantityMilli: 2_000,
      unit: 'kg',
      movementType: 'out',
      itemName: 'Rice',
    });
    const { record } = await confirm(fixture, proposal);

    const error = await (async () => {
      try {
        await correct(fixture, record.id, record.version, { quantityMilli: 5_000 });
        return null;
      } catch (caught) {
        return caught as AppError;
      }
    })();

    assert.equal(error?.code, ERROR_CODES.VALIDATION_FAILED);
    assert.match(error?.message ?? '', /cannot be corrected/i);
  });

  it('cannot reach another tenant record', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture);
    const { record } = await confirm(fixture, proposal);

    const error = await (async () => {
      try {
        await applyCorrection(fixture.db, fixture.other.context, {
          recordId: record.id,
          expectedVersion: record.version,
          action: 'reverse',
          reasonCode: 'recorded_in_error',
          actorUserId: 'someone-else',
        });
        return null;
      } catch (caught) {
        return caught as AppError;
      }
    })();

    assert.equal(error?.status, 404, 'a cross-tenant record must look absent');
    assert.equal((await findLedgerRecordById(fixture.db, fixture.scope, record.id))?.status, 'posted');
  });
});

describe('applyCorrection: reversal', () => {
  it('drops a reversed sale from cash totals and from deni', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, { customerName: 'Mama Salma', paymentStatus: 'unpaid' });
    const { record } = await confirm(fixture, proposal);

    const before = await cashSummary(fixture.db, fixture.context, {
      from: range.from,
      toExclusive: range.toExclusive,
    });
    assert.equal(before.current.moneyInMinor, 0);
    const customer = await findCustomerByName(fixture.db, fixture.scope, 'Mama Salma');
    assert.ok(customer);
    assert.equal((await customerBalances(fixture.db, fixture.scope, '2026-03-31'))[0]?.balanceMinor, 50_000);

    const result = await reverse(fixture, record.id, record.version);

    assert.equal(result.record.status, 'reversed');
    assert.equal(result.record.version, 2);
    assert.equal(
      (await customerBalances(fixture.db, fixture.scope, '2026-03-31')).length,
      0,
      'a reversed sale must stop counting as deni',
    );
    const voided = await listObligationsForRecord(fixture.db, fixture.scope, record.id);
    assert.equal(voided.length, 1, 'the obligation row is kept, never deleted');
    assert.equal(voided[0]?.state, 'voided');
  });

  it('removes a reversed sale from the period totals used by reports', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, {
      customerName: null,
      paymentStatus: 'paid',
      amountMinor: 30_000,
      occurredAt: '2026-03-15T10:00:00.000Z',
    });
    const { record } = await confirm(fixture, proposal);
    const { fromMs, toExclusiveMs } = dateRangeToUtcMs(range, fixture.context.timezone);
    assert.equal((await periodTotals(fixture.db, fixture.scope, fromMs, toExclusiveMs)).salesRecordedMinor, 30_000);

    await reverse(fixture, record.id, record.version);

    assert.equal(
      (await periodTotals(fixture.db, fixture.scope, fromMs, toExclusiveMs)).salesRecordedMinor,
      0,
      'reports read posted records only, so a reversal must leave the period clean',
    );
  });

  it('reopens a settled obligation when a payment is reversed', async () => {
    const fixture = await createFixture();
    const sale = await seedProposal(fixture, { customerName: 'Mama Salma', paymentStatus: 'unpaid' });
    await confirm(fixture, sale);
    const payment = await seedProposal(fixture, {
      recordType: 'debt_payment',
      customerName: 'Mama Salma',
      amountMinor: 50_000,
      paymentStatus: 'paid',
    });
    const { record: paymentRecord } = await confirm(fixture, payment);
    const customer = await findCustomerByName(fixture.db, fixture.scope, 'Mama Salma');
    assert.ok(customer);
    assert.equal(
      (await customerBalances(fixture.db, fixture.scope, '2026-03-31')).length,
      0,
      'a fully paid debt drops out of the owing list',
    );
    assert.equal((await listObligationsForCustomer(fixture.db, fixture.scope, customer.id))[0]?.state, 'settled');

    await reverse(fixture, paymentRecord.id, paymentRecord.version);

    assert.equal(
      (await customerBalances(fixture.db, fixture.scope, '2026-03-31'))[0]?.balanceMinor,
      50_000,
      'reversing the payment must bring the debt back',
    );
    assert.equal(
      (await listObligationsForCustomer(fixture.db, fixture.scope, customer.id))[0]?.state,
      'open',
      'the obligation must not stay marked settled after its payment was reversed',
    );
  });

  it('refuses to reverse the same record twice', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture);
    const { record } = await confirm(fixture, proposal);
    const reversed = await reverse(fixture, record.id, record.version);

    const error = await (async () => {
      try {
        await reverse(fixture, record.id, reversed.record.version);
        return null;
      } catch (caught) {
        return caught as AppError;
      }
    })();

    assert.equal(error?.code, ERROR_CODES.RECORD_NOT_POSTED);
    assert.equal(error?.status, 409);
  });

  it('refuses to reverse a note', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, {
      recordType: 'note',
      amountMinor: null,
      paymentStatus: null,
      description: null,
      note: 'Called the supplier about restocking',
    });
    const { record } = await confirm(fixture, proposal);

    const error = await (async () => {
      try {
        await reverse(fixture, record.id, record.version);
        return null;
      } catch (caught) {
        return caught as AppError;
      }
    })();

    assert.equal(error?.code, ERROR_CODES.VALIDATION_FAILED);
  });
});
