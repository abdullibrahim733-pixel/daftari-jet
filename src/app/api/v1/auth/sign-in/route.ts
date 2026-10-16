/**
 * Credential sign-in.
 *
 * Exchanges an email address and password for the same opaque session cookie the
 * rest of the application already uses, so every permission check, tenant
 * resolution and audit path downstream is unchanged.
 *
 * Failure is deliberately uniform. An unknown address, a wrong password and a
 * disabled account all return the same 401 with the same message and each costs
 * one scrypt derivation, so the endpoint cannot be used to enumerate accounts.
 */

import { z } from 'zod';
import { getDatabase } from '@/server/db/client';
import { issueSession } from '@/server/auth/session-store';
import { setSessionCookie } from '@/server/auth/session';
import { verifyPassword } from '@/server/auth/password';
import { clientKeyFrom, consume, reset } from '@/server/auth/rate-limit';
import { accessibleBusinesses } from '@/server/business-context/resolve';
import { findUserByEmail } from '@/server/repositories/business.repository';
import { permissionsForRole } from '@/server/permissions/policy';
import { unauthenticated, AppError, ERROR_CODES } from '@/lib/errors';
import { ok, parseBody, route } from '@/server/http/route';
import { logger } from '@/server/observability/logger';

/** Attempts per address and per client per 15 minutes. */
const LIMIT_PER_EMAIL = 8;
const LIMIT_PER_CLIENT = 40;

const signInSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
});

export const POST = route(async (request) => {
  const db = getDatabase();
  // The body can only be read once, so parse exactly once and validate before
  // any rate-limit or lookup work happens.
  const { email: rawEmail, password } = await parseBody(request, signInSchema);
  const email = rawEmail.trim().toLowerCase();

  const clientKey = clientKeyFrom(request);

  const clientLimit = consume(`client:${clientKey}`, LIMIT_PER_CLIENT);
  if (!clientLimit.allowed) {
    throw new AppError(429, ERROR_CODES.RATE_LIMITED, 'Too many sign-in attempts. Try again in a few minutes.');
  }

  const emailLimit = consume(`email:${email}`, LIMIT_PER_EMAIL);
  if (!emailLimit.allowed) {
    throw new AppError(429, ERROR_CODES.RATE_LIMITED, 'Too many sign-in attempts. Try again in a few minutes.');
  }

  const user = await findUserByEmail(db, email);

  // Verify unconditionally: when there is no account the helper still runs a
  // derivation, so the response time does not reveal whether the row exists.
  const valid = await verifyPassword(password, user?.password_hash);
  if (!user || !valid || user.status !== 'active') {
    logger.info('auth.sign_in_failed', {
      // Address is lowercased and truncated; it is never a password or a token.
      emailHint: email.slice(0, 3) + '***',
      reason: !user ? 'unknown_account' : !valid ? 'bad_password' : 'disabled',
    });
    throw unauthenticated('That email and password do not match an account.');
  }

  reset(`email:${email}`);

  const businesses = await accessibleBusinesses(db, user.id);
  const activeBusinessId = businesses[0]?.businessId ?? null;
  const active = businesses.find((entry) => entry.businessId === activeBusinessId) ?? null;

  const issued = await issueSession(db, {
    userId: user.id,
    activeBusinessId,
    userAgent: request.headers.get('user-agent'),
  });
  await setSessionCookie(issued.token);

  return ok({
    user: { id: user.id, displayName: user.display_name },
    activeBusinessId,
    businesses,
    permissions: active ? permissionsForRole(active.role) : [],
  });
});