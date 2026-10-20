/**
 * Session storage: the framework-free half of authentication.
 *
 * Nothing here imports `next/headers`, so the token contract (opaque cookie
 * value, hashed at rest, revocable, expiring) can be exercised directly
 * against a database. `session.ts` adds the HTTP cookie layer on top.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '@/server/db/client';
import {
  createSession,
  findActiveSession,
  findUserById,
  revokeSession,
  setSessionActiveBusiness,
  type SessionRow,
  type UserRow,
} from '@/server/repositories/business.repository';

export const SESSION_COOKIE_NAME = 'daftari_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/**
 * Developer sign-in is a local-only convenience, never a deployment switch.
 *
 * The previous contract let production re-enable it with
 * `DAFTARI_ALLOW_DEV_LOGIN=1`. The live deployment had that variable set, which
 * turned `POST /api/v1/dev/login` into an unauthenticated account-creation
 * endpoint: anyone could mint a session, and passing `businessName` also minted
 * a business with `owner` role. The variable name is still read for backwards
 * compatibility with local `.env` files, but production can no longer opt in,
 * so the flag can no longer become an accidental back door.
 */
export function devLoginEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.DAFTARI_ALLOW_DEV_LOGIN !== '0';
}

export function newOpaqueSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Native clients send this header on sign-in and registration to get the token in the body. */
export const MOBILE_CLIENT_HEADER = 'x-daftari-client';

export function isMobileClient(headerValue: string | null | undefined): boolean {
  return headerValue?.trim().toLowerCase() === 'mobile';
}

/**
 * Extracts the opaque session token from an `Authorization: Bearer` header.
 * It is the same token the cookie carries, so validation, expiry and
 * revocation are identical for web and native clients.
 */
export function bearerTokenFrom(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(headerValue.trim());
  return match?.[1] ?? null;
}

/** Only this hash reaches the database; the raw token lives in the cookie. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function hashUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  return createHash('sha256').update(userAgent).digest('hex').slice(0, 32);
}

export type IssuedSession = { sessionId: string; expiresAt: string; token: string };

export async function issueSession(
  db: Db,
  input: { userId: string; activeBusinessId: string | null; userAgent?: string | null },
): Promise<IssuedSession> {
  const token = newOpaqueSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const session = await createSession(db, {
    userId: input.userId,
    activeBusinessId: input.activeBusinessId,
    expiresAt,
    tokenHash: hashSessionToken(token),
    userAgentHash: hashUserAgent(input.userAgent ?? null),
  });
  return { sessionId: session.id, expiresAt, token };
}

export type AuthenticatedSession = {
  session: SessionRow;
  user: UserRow;
  db: Db;
};

/** Resolves a cookie token to a live session and an active user. */
export async function resolveSessionToken(db: Db, token: string): Promise<AuthenticatedSession | null> {
  const session = await findActiveSession(db, hashSessionToken(token));
  if (!session) return null;
  const user = await findUserById(db, session.user_id);
  if (!user || user.status !== 'active') return null;
  return { session, user, db };
}

export async function endSession(db: Db, sessionId: string): Promise<void> {
  await revokeSession(db, sessionId);
}

export async function switchActiveBusiness(db: Db, sessionId: string, businessId: string): Promise<void> {
  await setSessionActiveBusiness(db, sessionId, businessId);
}
