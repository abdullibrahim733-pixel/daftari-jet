/**
 * Cash summary for the dashboard and the reports screen.
 *
 * "Money in" only counts money actually received, and deni is deliberately not
 * part of it: an unpaid sale is a sale, but the cash has not arrived yet.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { cashSummary, deniSummary } from '@/server/services/reports';
import { countOpenProposals } from '@/server/repositories/source.repository';
import { tenantScope } from '@/server/business-context/context';
import { ok, route } from '@/server/http/route';
import { rangeFromQuery } from '@/server/http/report-range';

export const GET = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'reports.read');

  const range = rangeFromQuery(request, context.timezone);
  const summary = await cashSummary(db, context, range);

  return ok({
    range,
    timezone: context.timezone,
    currency: context.currency,
    summary,
    deni: context.features.deni ? await deniSummary(db, context) : null,
    reviewQueue: { open: await countOpenProposals(db, tenantScope(context)) },
  });
});
