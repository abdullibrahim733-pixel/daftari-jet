/**
 * Cash reporting.
 *
 * The cash formula is the number a merchant will argue with, so it is pinned
 * here rather than left to the SQL: money in is *cash received*, which is
 * paid sales plus debt payments collected, and never sales merely recorded.
 * Deni is deliberately excluded — selling on credit brings in no cash.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './helpers/fixture';
import { type Db } from '@/server/db/client';
import { insertLedgerRecord } from '@/server/repositories/ledger.repository';
import { cashSummary, cashTrend, salesByCategory } from '@/server/services/reports';
import { dateRangeToUtcMs } from '@/lib/formatting/datetime';

type SaleInput = {
  amountMinor: number;
  paymentStatus?: 'paid' | 'unpaid' | 'partial';
  occurredAt?: string;
  customerId?: string | null;
  description?: string;
};

async function postSale(
  db: Db,
  businessId: string,
  userId: string,
  input: SaleInput,
) {
  return await insertLedgerRecord(db, {
    businessId,
    recordType: 'sale',
    occurredAt: input.occurredAt ?? '2026-03-10T09:00:00.000Z',
    currency: 'TZS',
    amountMinor: input.amountMinor,
    description: input.description ?? null,
    customerId: input.customerId ?? null,
    payeeName: null,
    origin: 'manual',
    sourceEventId: null,
    proposalId: null,
    createdByUserId: userId,
    detail: { paymentStatus: input.paymentStatus ?? 'paid', paymentMethod: 'cash', items: [] },
  });
}

async function postExpense(
  db: Db,
  businessId: string,
  userId: string,
  amountMinor: number,
  category = 'rent',
  occurredAt = '2026-03-11T09:00:00.000Z',
) {
  return await insertLedgerRecord(db, {
    businessId,
    recordType: 'expense',
    occurredAt,
    currency: 'TZS',
    amountMinor,
    description: null,
    customerId: null,
    payeeName: null,
    origin: 'manual',
    sourceEventId: null,
    proposalId: null,
    createdByUserId: userId,
    detail: { category, items: [] },
  });
}

async function postDebtPayment(
  db: Db,
  businessId: string,
  userId: string,
  amountMinor: number,
  occurredAt = '2026-03-12T09:00:00.000Z',
) {
  return await insertLedgerRecord(db, {
    businessId,
    recordType: 'debt_payment',
    occurredAt,
    currency: 'TZS',
    amountMinor,
    description: null,
    customerId: null,
    payeeName: null,
    origin: 'manual',
    sourceEventId: null,
    proposalId: null,
    createdByUserId: userId,
    detail: { paymentMethod: 'cash', items: [] },
  });
}

const march = { from: '2026-03-01', toExclusive: '2026-04-01' };

describe('cashSummary', () => {
  it('counts only cash received as money in', async () => {
    const { db, context, userId, businessId } = await createFixture();

    await postSale(db, businessId, userId, { amountMinor: 100_000, paymentStatus: 'paid' });
    await postSale(db, businessId, userId, { amountMinor: 50_000, paymentStatus: 'unpaid' });
    await postDebtPayment(db, businessId, userId, 20_000);
    await postExpense(db, businessId, userId, 30_000);

    const summary = await cashSummary(db, context, march);

    assert.equal(summary.current.salesRecordedMinor, 150_000);
    assert.equal(summary.current.salesReceivedMinor, 100_000);
    assert.equal(summary.current.debtPaymentsReceivedMinor, 20_000);
    assert.equal(summary.current.moneyInMinor, 120_000);
    assert.equal(summary.current.moneyOutMinor, 30_000);
    assert.equal(summary.netCashMinor, 90_000);
  });

  it('excludes records outside the period', async () => {
    const { db, context, userId, businessId } = await createFixture();

    await postSale(db, businessId, userId, { amountMinor: 10_000, occurredAt: '2026-02-25T09:00:00.000Z' });
    await postSale(db, businessId, userId, { amountMinor: 20_000, occurredAt: '2026-04-10T09:00:00.000Z' });
    await postSale(db, businessId, userId, { amountMinor: 30_000, occurredAt: '2026-03-05T09:00:00.000Z' });

    const summary = await cashSummary(db, context, march);

    assert.equal(summary.current.salesRecordedMinor, 30_000);
    assert.equal(summary.current.confirmedCount, 1);
  });

  it('draws the period boundary in the business timezone, not in UTC', async () => {
    const { db, context, userId, businessId } = await createFixture();

    // Dar es Salaam is UTC+3, so 23:30 UTC on the 31st is already 1 April
    // locally and belongs to the next period.
    await postSale(db, businessId, userId, { amountMinor: 11_000, occurredAt: '2026-03-31T23:30:00.000Z' });
    // 20:00 UTC on the 31st is 23:00 local, still March.
    await postSale(db, businessId, userId, { amountMinor: 12_000, occurredAt: '2026-03-31T20:00:00.000Z' });
    // 21:30 UTC on the 28th is 00:30 on 1 March locally, so it is in.
    await postSale(db, businessId, userId, { amountMinor: 13_000, occurredAt: '2026-02-28T21:30:00.000Z' });
    // 20:30 UTC on the 28th is still 23:30 on 28 February locally.
    await postSale(db, businessId, userId, { amountMinor: 14_000, occurredAt: '2026-02-28T20:30:00.000Z' });

    const summary = await cashSummary(db, context, march);

    assert.equal(summary.current.salesRecordedMinor, 25_000);
    assert.equal(summary.current.confirmedCount, 2);  });

  it('compares against the immediately preceding period of equal length', async () => {
    const { db, context, userId, businessId } = await createFixture();

    await postSale(db, businessId, userId, { amountMinor: 40_000, occurredAt: '2026-02-10T09:00:00.000Z' });
    await postSale(db, businessId, userId, { amountMinor: 50_000 });

    const summary = await cashSummary(db, context, march);

    assert.equal(summary.previous.salesReceivedMinor, 40_000);
    assert.equal(summary.current.salesReceivedMinor, 50_000);
    assert.equal(summary.growthPercent.moneyIn, 25);
  });

  it('reports no growth percentage when the previous period was empty', async () => {
    const { db, context, userId, businessId } = await createFixture();
    await postSale(db, businessId, userId, { amountMinor: 50_000 });

    const summary = await cashSummary(db, context, march);

    assert.equal(summary.previous.moneyInMinor, 0);
    assert.equal(summary.growthPercent.moneyIn, null);
  });

  it('rejects an inverted period', async () => {
    const { db, context } = await createFixture();
    await assert.rejects(async () =>
      await cashSummary(db, context, { from: '2026-04-01', toExclusive: '2026-03-01' }),
    );
  });
});

describe('cashTrend', () => {
  it('buckets cash movement by day in the business timezone', async () => {
    const { db, context, userId, businessId } = await createFixture();

    await postSale(db, businessId, userId, { amountMinor: 5_000, occurredAt: '2026-03-02T06:00:00.000Z' });
    await postExpense(db, businessId, userId, 2_000, 'rent', '2026-03-02T09:00:00.000Z');
    await postSale(db, businessId, userId, { amountMinor: 7_000, occurredAt: '2026-03-04T09:00:00.000Z' });

    const trend = await cashTrend(db, context, march);

    assert.deepEqual(
      trend.map((bucket) => bucket.bucket),
      ['2026-03-02', '2026-03-04'],
    );
    assert.equal(trend[0]?.salesMinor, 5_000);
    assert.equal(trend[0]?.expensesMinor, 2_000);
    assert.equal(trend[1]?.salesMinor, 7_000);
  });
});

describe('salesByCategory', () => {
  it('groups sales and expenses separately by category', async () => {
    const { db, context, userId, businessId } = await createFixture();

    await postSale(db, businessId, userId, { amountMinor: 10_000 });
    await postSale(db, businessId, userId, { amountMinor: 5_000 });
    await postExpense(db, businessId, userId, 3_000, 'transport');

    const sales = await salesByCategory(db, context, march);

    // Uncategorized sales land in a single bucket rather than disappearing.
    assert.equal(sales.length, 1);
    assert.equal(sales[0]?.amountMinor, 15_000);
    assert.equal(sales[0]?.count, 2);
  });
});

describe('deniSummary', () => {
  it('never counts deni as cash', async () => {
    const { db, context, userId, businessId } = await createFixture();

    await postSale(db, businessId, userId, { amountMinor: 80_000, paymentStatus: 'unpaid' });
    await postExpense(db, businessId, userId, 10_000);
    const { fromMs, toExclusiveMs } = dateRangeToUtcMs(march, context.timezone);

    assert.equal((await cashSummary(db, context, march)).netCashMinor, -10_000);
    assert.ok(toExclusiveMs > fromMs);
  });
});
