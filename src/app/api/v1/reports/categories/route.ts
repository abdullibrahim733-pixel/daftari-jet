/**
 * Where the money came from and where it went.
 *
 * Sales and expenses are read from separate detail tables, so they are reported
 * separately and never netted into a single misleading number.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { expensesByCategory, salesByCategory } from '@/server/services/reports';
import { ok, route } from '@/server/http/route';
import { rangeFromQuery } from '@/server/http/report-range';

export const GET = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'reports.read');

  const range = rangeFromQuery(request, context.timezone);
  const sales = await salesByCategory(db, context, range);
  const expenses = await expensesByCategory(db, context, range);
  const salesTotal = sales.reduce((sum, entry) => sum + entry.amountMinor, 0);
  const expensesTotal = expenses.reduce((sum, entry) => sum + entry.amountMinor, 0);

  return ok({
    range,
    sales: {
      totalMinor: salesTotal,
      categories: sales.map((entry) => ({
        ...entry,
        share: salesTotal > 0 ? Math.round((entry.amountMinor / salesTotal) * 100) / 100 : 0,
      })),
    },
    expenses: {
      totalMinor: expensesTotal,
      categories: expenses.map((entry) => ({
        ...entry,
        share: expensesTotal > 0 ? Math.round((entry.amountMinor / expensesTotal) * 100) / 100 : 0,
      })),
    },
  });
});
