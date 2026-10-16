/**
 * Reporting service.
 *
 * Every figure here is computed from `status = 'posted'` ledger rows in
 * the business timezone, and every cash number follows the same
 * formula: money in (paid sales + debt payments received) minus
 * expenses. Nothing in this module writes.
 */

import type { Db } from '@/server/db/client';
import { dateRangeToUtcMs, todayInZone, type DateRange } from '@/lib/formatting/datetime';
import { bucketKeyForInstant } from '@/lib/formatting/datetime';
import type { BusinessContext } from '@/server/business-context/context';
import {
  cashSeries,
  periodTotals,
  totalsByCategory,
  type CashBucket,
  type CategoryTotal,
  type PeriodTotals,
} from '@/server/repositories/ledger.repository';
import {
  totalOutstandingMinor,
  totalOverdueMinor,
  customerBalances,
  customersWithBalanceCount,
  type CustomerBalance,
} from '@/server/repositories/debt.repository';
import { countLowStockItems, itemsWithBalances } from '@/server/repositories/inventory.repository';

export type CashSummary = {
  from: string;
  toExclusive: string;
  current: PeriodTotals;
  previous: PeriodTotals;
  /** Money in minus money out, in minor units. */
  netCashMinor: number;
  growthPercent: {
    moneyIn: number | null;
    moneyOut: number | null;
  };
};

export type DeniSummary = {
  outstandingMinor: number;
  overdueMinor: number;
  customersWithBalance: number;
  customers: CustomerBalance[];
};

export type InventorySummary = {
  lowStockCount: number;
  trackedItems: number;
};

/** A period and the immediately preceding period of the same length. */
export function withPreviousPeriod(range: DateRange): {
  range: DateRange;
  previous: DateRange;
} {
  const fromMs = Date.parse(`${range.from}T00:00:00Z`);
  const toMs = Date.parse(`${range.toExclusive}T00:00:00Z`);
  const lengthMs = toMs - fromMs;
  const previousTo = range.from;
  const previousFrom = new Date(fromMs - lengthMs).toISOString().slice(0, 10);
  return {
    range,
    previous: { from: previousFrom, toExclusive: previousTo },
  };
}

export async function cashSummary(db: Db, context: BusinessContext, range: DateRange): Promise<CashSummary> {
  const { fromMs, toExclusiveMs } = dateRangeToUtcMs(range, context.timezone);
  const { previous } = withPreviousPeriod(range);
  const previousMs = dateRangeToUtcMs(previous, context.timezone);

  const current = await periodTotals(db, { businessId: context.businessId }, fromMs, toExclusiveMs);
  const prior = await periodTotals(
    db,
    { businessId: context.businessId },
    previousMs.fromMs,
    previousMs.toExclusiveMs,
  );

  const growth = (currentValue: number, previousValue: number): number | null => {
    if (previousValue === 0) return currentValue > 0 ? null : null;
    return Number((((currentValue - previousValue) / previousValue) * 100).toFixed(1));
  };

  return {
    from: range.from,
    toExclusive: range.toExclusive,
    current,
    previous: prior,
    netCashMinor: current.netCashMovementMinor,
    growthPercent: {
      moneyIn: growth(current.moneyInMinor, prior.moneyInMinor),
      moneyOut: growth(current.moneyOutMinor, prior.moneyOutMinor),
    },
  };
}

export async function cashTrend(
  db: Db,
  context: BusinessContext,
  range: DateRange,
  granularity: 'day' | 'week' | 'month' = 'day',
): Promise<CashBucket[]> {
  const { fromMs, toExclusiveMs } = dateRangeToUtcMs(range, context.timezone);
  return await cashSeries(
    db,
    { businessId: context.businessId },
    fromMs,
    toExclusiveMs,
    (instantMs) => bucketKeyForInstant(instantMs, context.timezone, granularity),
  );
}

export async function salesByCategory(
  db: Db,
  context: BusinessContext,
  range: DateRange,
): Promise<CategoryTotal[]> {
  const { fromMs, toExclusiveMs } = dateRangeToUtcMs(range, context.timezone);
  return await totalsByCategory(db, { businessId: context.businessId }, fromMs, toExclusiveMs, 'sale');
}

export async function expensesByCategory(
  db: Db,
  context: BusinessContext,
  range: DateRange,
): Promise<CategoryTotal[]> {
  const { fromMs, toExclusiveMs } = dateRangeToUtcMs(range, context.timezone);
  return await totalsByCategory(db, { businessId: context.businessId }, fromMs, toExclusiveMs, 'expense');
}

export async function deniSummary(db: Db, context: BusinessContext): Promise<DeniSummary> {
  const scope = { businessId: context.businessId };
  const today = todayInZone(context.timezone);
  return {
    outstandingMinor: await totalOutstandingMinor(db, scope),
    overdueMinor: await totalOverdueMinor(db, scope, today),
    customersWithBalance: await customersWithBalanceCount(db, scope),
    customers: (await customerBalances(db, scope, today)).slice(0, 50),
  };
}

export async function inventorySummary(db: Db, context: BusinessContext): Promise<InventorySummary> {
  const scope = { businessId: context.businessId };
  return {
    lowStockCount: await countLowStockItems(db, scope),
    trackedItems: (await itemsWithBalances(db, scope)).length,
  };
}
