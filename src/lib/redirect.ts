/**
 * Post-authentication redirect safety.
 *
 * The login screen carries a `?next=` destination so a merchant who followed a
 * deep link lands on the page they asked for. That parameter is attacker
 * controllable, so it is validated here rather than trusted at the call site.
 */

/**
 * Returns a same-origin path, or `/` when the input is not safe to follow.
 *
 * Rejected:
 *  - anything not starting with `/` (absolute URLs, `javascript:`)
 *  - `//host` (protocol-relative — a browser reads this as another origin)
 *  - `/\host` (backslashes are normalised to `//` by several browsers)
 *  - `/login` itself (redirecting to the screen you are already on loops)
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.includes('\\')) return '/';
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) return '/';
  return raw;
}