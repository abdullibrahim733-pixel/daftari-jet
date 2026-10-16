/**
 * Session endpoints.
 *
 * `GET` reports who is signed in and which businesses they can switch to.
 * `DELETE` signs out. There is no password flow here: the local development
 * login lives under `/api/v1/dev/**` and a deployment puts managed OIDC in
 * front of the same session store.
 */

import { devLoginEnabled, endSession } from '@/server/auth/session-store';
import { clearSessionCookie } from '@/server/auth/session';
import { accessibleBusinesses } from '@/server/business-context/resolve';
import { requireSession } from '@/server/auth/session';
import { permissionsForRole } from '@/server/permissions/policy';
import { ok, route, noContent } from '@/server/http/route';

export const GET = route(async () => {
  const session = await requireSession();
  const businesses = await accessibleBusinesses(session.db, session.user.id);
  const activeBusinessId = session.session.active_business_id ?? businesses[0]?.businessId ?? null;
  const active = businesses.find((entry) => entry.businessId === activeBusinessId) ?? null;

  return ok({
    user: { id: session.user.id, displayName: session.user.display_name },
    businesses,
    activeBusinessId,
    role: active?.role ?? null,
    permissions: active ? permissionsForRole(active.role) : [],
    devLoginEnabled: devLoginEnabled(),
  });
});

export const DELETE = route(async () => {
  const session = await requireSession();
  await endSession(session.db, session.session.id);
  await clearSessionCookie();
  return noContent();
});
