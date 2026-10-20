/**
 * Account registration.
 *
 * Creates the user, their first business, and an `owner` membership in one
 * transaction, then issues the same session cookie as sign-in. This is the
 * entry point that onboarding continues from: a brand new owner lands on an
 * empty Record screen with a real workspace rather than a fabricated record.
 *
 * Sign-up is rate limited per client so the endpoint cannot be used to create
 * rows in bulk, and a taken address is reported plainly because the caller
 * already owns that address.
 */

import { z } from 'zod';
import { getDatabase, withTransaction } from '@/server/db/client';
import { MOBILE_CLIENT_HEADER, isMobileClient, issueSession } from '@/server/auth/session-store';
import { setSessionCookie } from '@/server/auth/session';
import { checkPasswordPolicy, hashPassword } from '@/server/auth/password';
import { clientKeyFrom, consume } from '@/server/auth/rate-limit';
import { accessibleBusinesses } from '@/server/business-context/resolve';
import {
  createBusiness,
  createMembership,
  createUser,
  emailInUse,
} from '@/server/repositories/business.repository';
import { permissionsForRole } from '@/server/permissions/policy';
import { AppError, ERROR_CODES, validationFailed } from '@/lib/errors';
import { ok, parseBody, route } from '@/server/http/route';
import { logger } from '@/server/observability/logger';

/** Registrations per client per 15 minutes. */
const LIMIT_PER_CLIENT = 5;

const registerSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
  displayName: z.string().trim().min(1).max(120),
  businessName: z.string().trim().min(1).max(120),
});

/** A plausible address shape, not a deliverability guarantee. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

export const POST = route(async (request) => {
  const db = getDatabase();
  const body = await parseBody(request, registerSchema);

  const email = body.email.trim().toLowerCase();
  if (!looksLikeEmail(email)) {
    throw validationFailed('Enter an email address like name@business.co.tz', {
      fields: ['email: not a valid address'],
    });
  }

  const policy = checkPasswordPolicy(body.password);
  if (!policy.ok) {
    throw validationFailed(policy.reason, { fields: ['password: policy'] });
  }

  const clientLimit = consume(`register:${clientKeyFrom(request)}`, LIMIT_PER_CLIENT);
  if (!clientLimit.allowed) {
    throw new AppError(429, ERROR_CODES.RATE_LIMITED, 'Too many accounts created. Try again in a few minutes.');
  }

  if (await emailInUse(db, email)) {
    throw new AppError(409, ERROR_CODES.VALIDATION_FAILED, 'An account already uses that email address.');
  }

  // Hash before opening the transaction: scrypt is deliberately slow and
  // holding a database transaction open across it would hold a pooled
  // connection for ~100ms of otherwise idle work.
  const passwordHash = await hashPassword(body.password);

  const created = await withTransaction(async () => {
    // Re-check inside the transaction: two concurrent sign-ups for the same
    // address can both pass the check above, and only the unique index will
    // settle it. This keeps the loser from getting a half-built workspace.
    if (await emailInUse(db, email)) {
      throw new AppError(409, ERROR_CODES.VALIDATION_FAILED, 'An account already uses that email address.');
    }

    // Provider subject is namespaced so a future managed-identity login for the
    // same person cannot collide with this credential row.
    const user = await createUser(db, {
      providerSubject: `email:${email}`,
      displayName: body.displayName.trim(),
      email,
      passwordHash,
      contactReference: email,
    });

    const business = await createBusiness(db, {
      name: body.businessName.trim(),
      businessType: 'shop',
      onboardingStep: 'connect',
    });
    await createMembership(db, { businessId: business.id, userId: user.id, role: 'owner' });

    return { user, businessId: business.id };
  }, db);

  const issued = await issueSession(db, {
    userId: created.user.id,
    activeBusinessId: created.businessId,
    userAgent: request.headers.get('user-agent'),
  });
  const mobile = isMobileClient(request.headers.get(MOBILE_CLIENT_HEADER));
  if (!mobile) await setSessionCookie(issued.token);

  logger.info('auth.registered', { userId: created.user.id });

  const businesses = await accessibleBusinesses(db, created.user.id);
  const active = businesses.find((entry) => entry.businessId === created.businessId) ?? null;

  return ok(
    {
      user: { id: created.user.id, displayName: created.user.display_name },
      activeBusinessId: created.businessId,
      businesses,
      permissions: active ? permissionsForRole(active.role) : [],
      ...(mobile ? { sessionToken: issued.token, expiresAt: issued.expiresAt } : {}),
    },
    { status: 201 },
  );
});