/**
 * In-process sliding-window rate limiter for credential endpoints.
 *
 * Scope note: this protects a single server instance. On a multi-instance
 * deployment the store must move to a shared backend (Redis/Neon) before this
 * is treated as a hard control — the window below is an abuse speed bump and a
 * correctness aid, not a distributed quota. The limits are deliberately tight
 * enough that a credential-stuffing run is still impractical, and every rejection
 * is uniform so the endpoint does not leak which factor failed.
 */

type Bucket = { hits: number[] };

const buckets = new Map<string, Bucket>();

/** Drop expired buckets so a long-running process cannot grow without bound. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    bucket.hits = bucket.hits.filter((at) => now - at < WINDOW_MS);
    if (bucket.hits.length === 0) buckets.delete(key);
  }
}

const WINDOW_MS = 15 * 60 * 1000;

export type RateLimitVerdict = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Records an attempt and reports whether it is permitted.
 *
 * `consume` is called only for actual attempts — a page view must not burn a
 * merchant's budget, otherwise a refresh loop could lock a real user out.
 */
export function consume(key: string, limit: number): RateLimitVerdict {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((at) => now - at < WINDOW_MS);

  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    const oldest = bucket.hits[0] ?? now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  return { allowed: true, remaining: limit - bucket.hits.length, retryAfterSeconds: 0 };
}

/**
 * Best-effort client identity for rate limiting.
 *
 * Prefers the first address in a proxy chain. Vercel sets `x-forwarded-for`;
 * the left-most entry is the original client. This is only used to slow abuse
 * down — an attacker can forge the header outside a trusted proxy, so no
 * authorization decision is derived from it.
 */
export function clientKeyFrom(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Clears a key after a successful sign-in so a legitimate user starts clean. */
export function reset(key: string): void {
  buckets.delete(key);
}

/** Test seam. */
export function resetAll(): void {
  buckets.clear();
  lastSweep = 0;
}