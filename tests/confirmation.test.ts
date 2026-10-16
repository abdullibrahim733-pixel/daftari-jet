/**
 * Review -> ledger confirmation.
 *
 * This is the path where a merchant's money is actually recorded, so the tests
 * pin the outcomes that would be hardest to notice in production: a walk-in
 * cash sale must not invent a customer, an unpaid sale must open deni, a
 * part payment must record only the cash received, a stale proposal version
 * must not double-post, and one tenant must never see another's data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, type Fixture } from './helpers/fixture';
import { confirmProposal, rejectProposal } from '@/server/services/confirmation';
import { ERROR_CODES, type AppError } from '@/lib/errors';
import { emptyProposalFields, missingRequiredFields, type ProposalFields } from '@/lib/validation/proposal';
import {
  insertProposal,
  insertSourceEvent,
  findProposalById,
  proposalFields,
  type ProposalRow,
} from '@/server/repositories/source.repository';
import { findLedgerRecordById, findLedgerRecordByProposal, countConfirmedRecords } from '@/server/repositories/ledger.repository';
import { customerBalances, findCustomerByName, listCustomers, listObligationsForCustomer } from '@/server/repositories/debt.repository';

let eventCounter = 0;

/** Creates a reviewable proposal with the fields a reviewer would see. */
async function seedProposal(
  fixture: Fixture,
  overrides: Partial<ProposalFields> & { recordType?: ProposalRow['record_type'] } = {},
): Promise<ProposalRow> {
  const { db, businessId } = fixture;
  eventCounter += 1;
  const sourceEvent = await insertSourceEvent(db, {
    businessId,
    integrationId: null,
    providerEventId: `evt_${eventCounter}`,
    eventType: 'message',
    senderRef: '+255700000001',
    receivedAt: '2026-03-10T08:00:00.000Z',
    providerSentAt: '2026-03-10T08:00:00.000Z',
    dedupeKey: `test:${eventCounter}`,
    redactedPayload: null,
  });

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
    recordType: overrides.recordType ?? 'sale',
    state: 'needs_review',
    schemaVersion: '1',
    provider: 'test',
    modelVersion: 'test',
    fields,
    provenance: {},
    missingFields: missingRequiredFields(overrides.recordType ?? 'sale', fields),
    validationIssues: [],
    duplicateCandidates: [],
  });
}

async function confirm(fixture: Fixture, proposal: ProposalRow, fields?: Partial<ProposalFields>) {
  return await confirmProposal(fixture.db, fixture.context, {
    proposalId: proposal.id,
    expectedVersion: proposal.version,
    confirmedByUserId: fixture.userId,
    fields,
  });
}

describe('confirmProposal', () => {
  it('posts a fully paid walk-in sale without inventing a customer', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, { customerName: null, paymentStatus: 'paid' });

    const result = await confirm(fixture, proposal);

    assert.equal(result.kind, 'confirmed');
    if (result.kind !== 'confirmed') return;
    assert.equal(result.customer, null);
    assert.equal(result.record.customer_id, null);
    assert.equal(result.record.amount_minor, 50_000);
    assert.equal(result.record.status, 'posted');
    assert.equal((await listCustomers(fixture.db, fixture.scope)).length, 0, 'no deni account should be created');

    const proposalRow = await findProposalById(fixture.db, fixture.scope, proposal.id);
    assert.equal(proposalRow?.state, 'confirmed');
  });

  it('opens deni for an unpaid sale and records the customer', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, { customerName: 'Mama Salma', paymentStatus: 'unpaid' });

    const result = await confirm(fixture, proposal);

    assert.equal(result.kind, 'confirmed');
    if (result.kind !== 'confirmed') return;
    assert.equal(result.customer?.display_name, 'Mama Salma');

    const customer = await findCustomerByName(fixture.db, fixture.scope, 'Mama Salma');
    assert.ok(customer, 'the deni account must exist');
    const obligations = await listObligationsForCustomer(fixture.db, fixture.scope, customer.id);
    assert.equal(obligations.length, 1);
    assert.equal(obligations[0]?.original_amount_minor, 50_000);
  });

  it('reuses an existing customer instead of creating a second account', async () => {
    const fixture = await createFixture();
    const first = await seedProposal(fixture, { customerName: 'Mama Salma', paymentStatus: 'unpaid' });
    await confirm(fixture, first);
    const second = await seedProposal(fixture, { customerName: 'mama salma', paymentStatus: 'unpaid' });
    await confirm(fixture, second);

    assert.equal((await listCustomers(fixture.db, fixture.scope)).length, 1);
  });

  it('records only the cash received as money in for a part payment', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, {
      customerName: 'Mama Salma',
      paymentStatus: 'partial',
      amountMinor: 50_000,
      amountPaidMinor: 20_000,
    });

    const result = await confirm(fixture, proposal);

    assert.equal(result.kind, 'confirmed');
    if (result.kind !== 'confirmed') return;
    const customer = result.customer;
    assert.ok(customer);
    const obligations = await listObligationsForCustomer(fixture.db, fixture.scope, customer.id);
    assert.equal(
      obligations[0]?.original_amount_minor,
      30_000,
      'deni must hold the unpaid remainder, not the full amount',
    );
    const balances = await customerBalances(fixture.db, fixture.scope, '2026-03-10');
    assert.equal(balances[0]?.balanceMinor, 30_000);
  });

  it('refuses a part payment with no amount recorded as paid', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, {
      customerName: 'Mama Salma',
      paymentStatus: 'partial',
      amountPaidMinor: null,
    });

    const result = await confirm(fixture, proposal);

    assert.equal(result.kind, 'invalid');
    if (result.kind !== 'invalid') return;
    assert.ok(result.issues.some((issue) => issue.field.includes('amountPaid')));
    assert.equal(await countConfirmedRecords(fixture.db, fixture.scope), 0, 'nothing may be posted');
  });

  it('lets the reviewer supply a missing amount and still confirm', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, {
      customerName: 'Mama Salma',
      paymentStatus: 'partial',
      amountPaidMinor: null,
    });

    const result = await confirm(fixture, proposal, { amountPaidMinor: 15_000 });

    assert.equal(result.kind, 'confirmed');
  });

  it('applies reviewer overrides before validating', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, {
      customerName: 'Mama Salma',
      paymentStatus: 'partial',
      amountPaidMinor: null,
    });

    const result = await confirm(fixture, proposal, { paymentStatus: 'paid' });

    assert.equal(result.kind, 'confirmed');
    if (result.kind !== 'confirmed') return;
    // Fully paid means nobody owes money, so no deni account is needed.
    assert.equal(result.customer, null);
  });

  it('refuses to confirm with a stale proposal version', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture);

    await assert.rejects(
      async () =>
        await confirmProposal(fixture.db, fixture.context, {
          proposalId: proposal.id,
          expectedVersion: proposal.version + 5,
          confirmedByUserId: fixture.userId,
        }),
      (error: AppError) => error.code === ERROR_CODES.PROPOSAL_VERSION_CONFLICT && error.status === 409,
    );
    assert.equal(await countConfirmedRecords(fixture.db, fixture.scope), 0);
  });

  it('posts exactly one record when the same confirmation is retried', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture);

    const first = await confirm(fixture, proposal);
    const second = await confirm(fixture, proposal);

    assert.equal(first.kind, 'confirmed');
    assert.equal(second.kind, 'already_confirmed');
    assert.equal(await countConfirmedRecords(fixture.db, fixture.scope), 1);
  });

  it('links the proposal, the source event and the ledger record', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture);

    const result = await confirm(fixture, proposal);

    assert.equal(result.kind, 'confirmed');
    if (result.kind !== 'confirmed') return;
    assert.equal(result.record.proposal_id, proposal.id);
    assert.equal(result.record.source_event_id, proposal.source_event_id);
    assert.equal(result.record.origin, 'whatsapp');
    assert.ok(await findLedgerRecordByProposal(fixture.db, fixture.scope, proposal.id));
    assert.ok(await findLedgerRecordById(fixture.db, fixture.scope, result.record.id));
  });

  it('refuses to confirm another tenant\'s proposal', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture);

    await assert.rejects(
      async () =>
        await confirmProposal(fixture.db, fixture.other.context, {
          proposalId: proposal.id,
          expectedVersion: proposal.version,
          confirmedByUserId: fixture.userId,
        }),
      (error: AppError) => error.status === 404,
    );
    assert.equal(await countConfirmedRecords(fixture.db, fixture.scope), 0);
    assert.equal(await countConfirmedRecords(fixture.db, { businessId: fixture.other.businessId }), 0);
  });
});

describe('rejectProposal', () => {
  it('records the decision without touching the ledger', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture);

    const rejected = await rejectProposal(fixture.db, fixture.context, {
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      rejectedByUserId: fixture.userId,
      reasonCode: 'wrong_amount',
      reasonNote: 'Merchant corrected it on paper',
    });

    assert.equal(rejected.state, 'rejected');
    assert.equal(rejected.rejection_reason_code, 'wrong_amount');
    assert.equal(await countConfirmedRecords(fixture.db, fixture.scope), 0);
  });

  it('refuses to confirm a rejected proposal later', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture);
    await rejectProposal(fixture.db, fixture.context, {
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      rejectedByUserId: fixture.userId,
      reasonCode: 'not_a_sale',
    });

    await assert.rejects(
      async () => await confirm(fixture, proposal),
      (error: AppError) => error.code === ERROR_CODES.PROPOSAL_NOT_REVIEWABLE,
    );
    assert.equal(await countConfirmedRecords(fixture.db, fixture.scope), 0);
  });
});

describe('proposal field completeness', () => {
  it('flags a part payment with no amount paid', () => {
    const fields: ProposalFields = {
      ...emptyProposalFields('TZS'),
      amountMinor: 50_000,
      occurredAt: '2026-03-10T08:00:00.000Z',
      paymentStatus: 'partial',
      amountPaidMinor: null,
    };

    assert.ok(missingRequiredFields('sale', fields).includes('amountPaidMinor'));
  });

  it('does not require a paid amount for a fully paid sale', () => {
    const fields: ProposalFields = {
      ...emptyProposalFields('TZS'),
      amountMinor: 50_000,
      occurredAt: '2026-03-10T08:00:00.000Z',
      paymentStatus: 'paid',
      amountPaidMinor: null,
    };

    assert.ok(!missingRequiredFields('sale', fields).includes('amountPaidMinor'));
  });

  it('rejects a part payment that claims to be more than the total', () => {
    const fields: ProposalFields = {
      ...emptyProposalFields('TZS'),
      amountMinor: 50_000,
      occurredAt: '2026-03-10T08:00:00.000Z',
      paymentStatus: 'partial',
      amountPaidMinor: 50_000,
    };

    assert.ok(missingRequiredFields('sale', fields).includes('amountPaidMinor'));
  });

  it('round-trips proposal fields through storage', async () => {
    const fixture = await createFixture();
    const proposal = await seedProposal(fixture, { customerName: 'Mama Salma' });

    assert.equal(proposalFields(await findProposalById(fixture.db, fixture.scope, proposal.id) as ProposalRow).customerName, 'Mama Salma');
  });
});
