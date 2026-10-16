/**
 * Switches the active business for the current session.
 *
 * The switch is verified against a real membership before it is stored, so a
 * client cannot move the session into a business it does not belong to.
 */

import { switchActiveBusiness } from '@/server/auth/session-store';
import { requireSession } from '@/server/auth/session';
import { resolveRequestContext } from '@/server/business-context/resolve';
import { forbidden } from '@/lib/errors';
import { ok, parseBody, route } from '@/server/http/route';
import { switchBusinessBodySchema } from '@/server/http/schemas';

export const POST = route(async (request) => {
  const session = await requireSession();
  const body = await parseBody(request, switchBusinessBodySchema);
  const resolution = await resolveRequestContext({
    requireBusiness: false,
    requestedBusinessId: body.businessId,
  });

  const target = resolution.businesses.find((entry) => entry.businessId === body.businessId);
  if (!target) {
    throw forbidden('You do not have access to this business');
  }

  await switchActiveBusiness(session.db, session.session.id, target.businessId);
  return ok({ activeBusinessId: target.businessId, role: target.role });
});
