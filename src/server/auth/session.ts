/**
 * Session handling for the HTTP-only cookie session.
 *
 * The production baseline calls for a managed OIDC provider with authorization
 * code + PKCE. This build uses seeded local accounts behind the same server-side
 * session contract, so the route layer, permission checks and tenant resolution
 * behave exactly as they will once the identity provider is wired in.
 *
 * The token rules live in `session-store.ts`; this module is only the cookie
 * boundary, because `next/headers` is not callable outside a request.
 */

import { cookies, headers } from 'next/headers';
import { getDatabase } from '@/server/db/client';
import { unauthenticated } from '@/lib/errors';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  bearerTokenFrom,
  resolveSessionToken,
  sessionCookieOptions,
  type AuthenticatedSession,
} from './session-store';

// Re-exported so route handlers can reach the whole session contract from one
// module; the implementations stay in the framework-free store.
export {
  MOBILE_CLIENT_HEADER,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  bearerTokenFrom,
  devLoginEnabled,
  endSession,
  hashSessionToken,
  hashUserAgent,
  isMobileClient,
  issueSession,
  newOpaqueSessionToken,
  sessionCookieOptions,
  switchActiveBusiness,
} from './session-store';
export type { AuthenticatedSession, IssuedSession } from './session-store';

/** The cookie wins; native clients, which have no cookie jar, send a bearer token. */
export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  const cookieToken = store.get(SESSION_COOKIE_NAME)?.value;
  if (cookieToken) return cookieToken;
  return bearerTokenFrom((await headers()).get('authorization'));
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(SESSION_TTL_SECONDS));
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, '', sessionCookieOptions(0));
}

export async function requireSession(): Promise<AuthenticatedSession> {
  const token = await readSessionToken();
  if (!token) throw unauthenticated();
  const db = getDatabase();
  const resolved = await resolveSessionToken(db, token);
  if (!resolved) throw unauthenticated('Your session has expired. Sign in again.');
  return resolved;
}

export async function optionalSession(): Promise<AuthenticatedSession | null> {
  const token = await readSessionToken();
  if (!token) return null;
  return await resolveSessionToken(getDatabase(), token);
}
