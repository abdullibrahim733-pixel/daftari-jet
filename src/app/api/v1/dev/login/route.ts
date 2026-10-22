/**
 * Local development login.
 *
 * A deployment replaces this with managed OIDC, which ends up calling the same
 * `issueSession`. The endpoint refuses to run when dev login is disabled and
 * never runs in production unless it is explicitly switched on, so it cannot
 * become an accidental back door.
 */

import { z } from 'zod';
import { getDatabase } from '@/server/db/client';
import { devLoginEnabled, issueSession, SESSION_TTL_SECONDS } from '@/server/auth/session-store';
import { setSessionCookie } from '@/server/auth/session';
import { accessibleBusinesses } from '@/server/business-context/resolve';
import {
  createBusiness,
  createMembership,
  createUser,
  findUserByProviderSubject,
  listBusinessesForUser,
} from '@/server/repositories/business.repository';
import { permissionsForRole } from '@/server/permissions/policy';
import { forbidden } from '@/lib/errors';
import { ok, parseBody, route } from '@/server/http/route';

const devLoginSchema = z.object({
  subject: z.string().trim().min(1).max(120).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  businessName: z.string().trim().min(1).max(120).optional(),
});

export const GET = route(async () => ok({ enabled: devLoginEnabled() }));

export const POST = route(async (request) => {
  if (!devLoginEnabled()) {
    throw forbidden('Local sign-in is disabled on this environment');
  }

  const db = getDatabase();
  const body = await parseBody(request, devLoginSchema);
  const subject = body.subject ?? 'dev-owner';

  const user =
    await findUserByProviderSubject(db, subject) ??
    await createUser(db, {
      providerSubject: subject,
      displayName: body.displayName ?? 'SAHL Owner',
    });

  let businessId = (await listBusinessesForUser(db, user.id))[0]?.id ?? null;
  if (!businessId && body.businessName) {
    const business = await createBusiness(db, { name: body.businessName, businessType: 'shop' });
    await createMembership(db, { businessId: business.id, userId: user.id, role: 'owner' });
    businessId = business.id;
  }

  const issued = await issueSession(db, {
    userId: user.id,
    activeBusinessId: businessId,
    userAgent: request.headers.get('user-agent'),
  });
  await setSessionCookie(issued.token);

  const businesses = await accessibleBusinesses(db, user.id);
  const active = businesses.find((entry) => entry.businessId === businessId) ?? null;

  return ok({
    user: { id: user.id, displayName: user.display_name },
    activeBusinessId: businessId,
    businesses,
    // The role comes from the membership, so the client's permission list can
    // never claim more than the tenant resolution will later enforce.
    permissions: active ? permissionsForRole(active.role) : [],
    expiresInSeconds: SESSION_TTL_SECONDS,
  });
});
