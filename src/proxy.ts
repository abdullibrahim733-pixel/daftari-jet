/**
 * Route gate.
 *
 * This runs before rendering, on every dashboard request. It deliberately does
 * *not* touch the database: Proxy is frequently deployed to the CDN where
 * shared modules and connections are not available, and the Next.js data
 * security guidance is explicit that Proxy alone is never an authorization
 * check. A missing cookie is only a hint that the caller is probably anonymous.
 *
 * The authoritative check — hashing the token, resolving the user, enforcing
 * status and revocation — lives in `(dashboard)/layout.tsx`, which runs on the
 * server with a real database connection. API routes already enforce it via
 * `requireSession()`.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Must match `SESSION_COOKIE_NAME` in `@/server/auth/session-store`. */
const SESSION_COOKIE = 'daftari_session';

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Auth pages are never gated, so an anonymous visitor can always reach sign-in.
  if (pathname === '/login' || pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  if (request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }

  // Preserve the destination so the login screen can return the user to the
  // page they actually asked for.
  const target = new URL('/login', request.url);
  target.searchParams.set('next', `${pathname}${search}`);

  const response = NextResponse.redirect(target);

  // Do not let a stale or hostile cached response be served for a redirect.
  response.headers.set('cache-control', 'no-store, private');
  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets and the favicon.
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
  ],
};