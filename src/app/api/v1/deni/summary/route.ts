/**
 * Deni summary.
 *
 * Deni is reported separately from cash on purpose: money owed to the business
 * is not money in the till, and the dashboard never adds the two together.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { deniSummary } from '@/server/services/reports';
import { customersWithBalanceCount } from '@/server/repositories/debt.repository';
import { tenantScope } from '@/server/business-context/context';
import { ok, route } from '@/server/http/route';

export const GET = route(async () => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'deni.read');

  if (!context.features.deni) {
    return ok({ enabled: false, summary: null });
  }

  const summary = await deniSummary(db, context);
  return ok({
    enabled: true,
    summary,
    customersWithBalance: await customersWithBalanceCount(db, tenantScope(context)),
  });
});
