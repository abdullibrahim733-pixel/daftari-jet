/**
 * Password hashing for credential sign-in.
 *
 * Uses scrypt from `node:crypto` rather than a dependency: the platform already
 * ships a memory-hard KDF, and the deployment contract in architecture.md keeps
 * the identity provider swappable behind this seam. If a managed provider lands
 * later it replaces the caller of `hashPassword`/`verifyPassword`, not the rest
 * of the application.
 *
 * Stored format — one self-describing string so parameters can be raised later
 * without invalidating existing hashes:
 *
 *     scrypt$<N>$<r>$<p>$<keylen>$<salt-b64>$<hash-b64>
 *
 * Verification reads the parameters back out of the stored string, so an old
 * hash keeps verifying after the cost factors are increased for new passwords.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** OWASP's scrypt baseline: N=2^17, r=8, p=1. */
const PARAMS = { N: 2 ** 17, r: 8, p: 1, keylen: 64 } as const;

/** scrypt needs roughly 128 * N * r bytes; give it headroom above the default 32MB. */
const MAXMEM = 256 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return scrypt(password.normalize('NFKC'), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAXMEM,
  }).then((derived) =>
    [
      'scrypt',
      PARAMS.N,
      PARAMS.r,
      PARAMS.p,
      PARAMS.keylen,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$'),
  );
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false for malformed or absent hashes rather than throwing, so a
 * corrupt row denies access instead of becoming a 500. Comparison is
 * constant-time, and the failure path still performs a derivation so an absent
 * account and a wrong password cost the same to an attacker.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) {
    await dummyDerivation();
    return false;
  }

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAXMEM,
    });
  } catch {
    return false;
  }

  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

type ParsedHash = {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
};

function parseStored(stored: string | null | undefined): ParsedHash | null {
  if (!stored) return null;
  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt') return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const keylen = Number(parts[4]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (!Number.isInteger(keylen) || keylen < 16 || keylen > 1024) return null;
  // Refuse absurd stored parameters rather than letting a tampered row ask the
  // server to allocate an unbounded amount of memory.
  if (N < 2 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;

  const salt = Buffer.from(parts[5] ?? '', 'base64');
  const hash = Buffer.from(parts[6] ?? '', 'base64');
  if (salt.length === 0 || hash.length !== keylen) return null;

  return { N, r, p, salt, hash };
}

/** Burns roughly one scrypt run so "no such user" and "wrong password" match. */
function dummyDerivation(): Promise<void> {
  return scrypt('daftari-timing-equalizer', randomBytes(16), PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAXMEM,
  }).then(() => undefined);
}

export type PasswordPolicyResult = { ok: true } | { ok: false; reason: string };

/**
 * Checks a candidate password against the policy the sign-up surface explains.
 * Kept in one place so the form, the API route and the tests cannot disagree.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > 200) {
    return { ok: false, reason: 'Use 200 characters or fewer.' };
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return { ok: false, reason: 'Use at least one uppercase letter, one lowercase letter and one number.' };
  }
  return { ok: true };
}