/**
 * Resolves the authenticated tenant context for every request.
 *
 * The client may send `X-Active-Business-Id` as a selector, but the server
 * verifies active membership on every request; a business identifier from an
 * untrusted body or header is never trusted on its own.
 */

import { headers } from 'next/headers';
import { forbidden, unauthenticated } from '@/lib/errors';
import { getDatabase, type Db } from '@/server/db/client';
import { requireSession, type AuthenticatedSession } from '@/server/auth/session';
import {
  findBusinessById,
  findMembership,
  listBusinessesForUser,
  type BusinessRow,
  type MembershipWithRole,
} from '@/server/repositories/business.repository';
import type { BusinessContext, TenantScope } from './context';
import { toBusinessContext } from './context';
import type { Role } from '@/server/domain/types';

export { contextForTesting, toBusinessContext } from './context';

export const ACTIVE_BUSINESS_HEADER = 'x-active-business-id';

export type AccessibleBusiness = {
  businessId: string;
  name: string;
  role: Role;
  membershipStatus: string;
  timezone: string;
  currency: string;
};

export async function accessibleBusinesses(db: Db, userId: string): Promise<AccessibleBusiness[]> {
  return (await listBusinessesForUser(db, userId)).map(
    (row: BusinessRow & MembershipWithRole): AccessibleBusiness => ({
      businessId: row.id,
      name: row.name,
      role: row.role,
      membershipStatus: row.membership_status,
      timezone: row.timezone,
      currency: row.currency,
    }),
  );
}

/** Picks the requested business, then the session default, then the first one. */
function selectBusinessId(
  requested: string | null | undefined,
  session: AuthenticatedSession,
  businesses: AccessibleBusiness[],
): string | null {
  if (requested) return requested;
  if (session.session.active_business_id) return session.session.active_business_id;
  return businesses[0]?.businessId ?? null;
}

export type ContextResolution = {
  session: AuthenticatedSession;
  businesses: AccessibleBusiness[];
  context: BusinessContext | null;
};

/**
 * Builds the tenant context for a page or API request.
 *
 * `requireBusiness: false` supports screens that render before a business is
 * chosen (onboarding, business picker).
 */
export async function resolveRequestContext(options?: {
  requireBusiness?: boolean;
  requestedBusinessId?: string | null;
}): Promise<ContextResolution> {
  const requireBusiness = options?.requireBusiness ?? true;
  const session = await requireSession();
  const businesses = await accessibleBusinesses(session.db, session.user.id);

  if (!requireBusiness) {
    return { session, businesses, context: null };
  }

  let headerBusinessId: string | null = null;
  if (!options?.requestedBusinessId) {
    const store = await headers();
    headerBusinessId = store.get(ACTIVE_BUSINESS_HEADER) ?? null;
  }

  const businessId = selectBusinessId(options?.requestedBusinessId ?? headerBusinessId, session, businesses);
  if (!businessId) {
    throw forbidden('You do not have access to a business yet', { reason: 'no_membership' });
  }

  const db = session.db;
  const membership = await findMembership(db, { businessId }, session.user.id);
  if (!membership) {
    // Cross-tenant access is reported as a permission failure without disclosing
    // whether the business exists.
    throw forbidden('You do not have access to this business');
  }
  const business = await findBusinessById(db, businessId);
  if (!business || business.status !== 'active') {
    throw forbidden('This business is not available');
  }
  return { session, businesses, context: toBusinessContext(session.user, business, membership.role) };
}

export type TenantRequest = {
  db: Db;
  context: BusinessContext;
  session: AuthenticatedSession;
  businesses: AccessibleBusiness[];
};

/**
 * Everything a tenant route needs in one verified step.
 *
 * The database handle comes from the resolved session rather than a fresh
 * lookup, so a request reads through the same connection it authenticated on.
 */
export async function requireTenant(options?: {
  requestedBusinessId?: string | null;
}): Promise<TenantRequest> {
  const resolution = await resolveRequestContext({
    requireBusiness: true,
    requestedBusinessId: options?.requestedBusinessId ?? null,
  });
  if (!resolution.context) throw unauthenticated();
  return {
    db: resolution.session.db,
    context: resolution.context,
    session: resolution.session,
    businesses: resolution.businesses,
  };
}

export async function requireBusinessContext(
  options?: { requestedBusinessId?: string | null },
): Promise<BusinessContext> {
  return (await requireTenant(options)).context;
}

/** Ensures the database schema exists before the first read in development. */
export function ensureDatabaseReady(): ReturnType<typeof getDatabase> {
  return getDatabase();
}

export function tenantOf(context: BusinessContext): TenantScope {
  return { businessId: context.businessId };
}