/**
 * Cash movement over time, bucketed by day, week or month in the business
 * timezone.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { cashTrend } from '@/server/services/reports';
import { ok, route } from '@/server/http/route';
import { granularityFromQuery, rangeFromQuery } from '@/server/http/report-range';

export const GET = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'reports.read');

  const range = rangeFromQuery(request, context.timezone);
  const granularity = granularityFromQuery(request);
  const buckets = await cashTrend(db, context, range, granularity);

  return ok({
    range,
    granularity,
    buckets,
    totals: buckets.reduce(
      (sum, bucket) => ({
        salesMinor: sum.salesMinor + bucket.salesMinor,
        expensesMinor: sum.expensesMinor + bucket.expensesMinor,
        netMinor: sum.netMinor + bucket.salesMinor - bucket.expensesMinor,
      }),
      { salesMinor: 0, expensesMinor: 0, netMinor: 0 },
    ),
  });
});
