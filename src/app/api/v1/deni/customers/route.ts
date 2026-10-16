/**
 * Customers with a deni balance.
 *
 * Sorted by who owes the most, because that is the list a merchant acts on.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { tenantScope } from '@/server/business-context/context';
import { assertCan } from '@/server/permissions/policy';
import { customerBalances } from '@/server/repositories/debt.repository';
import { todayInZone } from '@/lib/formatting/datetime';
import { ok, queryInt, route } from '@/server/http/route';

export const GET = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'deni.read');

  const today = todayInZone(context.timezone);
  const limit = queryInt(request, 'limit', 50, 200);
  const balances = await customerBalances(db, tenantScope(context), today);
  const withBalance = balances.filter((entry) => entry.balanceMinor !== 0);

  return ok({
    asOf: today,
    totalOutstandingMinor: withBalance.reduce((sum, entry) => sum + entry.balanceMinor, 0),
    customers: withBalance.slice(0, limit).map((entry) => ({
      customerId: entry.customerId,
      customerName: entry.customerName,
      balanceMinor: entry.balanceMinor,
      overdue: entry.overdue,
      oldestDebtDate: entry.oldestDebtDate,
      dueDate: entry.dueDate,
      obligationCount: entry.obligationCount,
      lastPaymentAt: entry.lastPaymentAt,
    })),
    page: { limit, total: withBalance.length },
  });
});
