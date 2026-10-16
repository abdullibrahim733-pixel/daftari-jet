/**
 * Short-lived signed links for private media.
 *
 * A stored object key alone never authorizes a read: every download carries a
 * token that binds the object key to an expiry and an HMAC. The scheme is
 * intentionally storage-independent so the local filesystem adapter and the
 * S3-compatible adapter issue interchangeable tokens.
 *
 * Token format: `base64url("<version>.<objectKey>.<expiresAtMs>").<signature>`.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolveDataDir } from '@/server/db/client';
import type { SignedMediaLink } from './port';

export const SIGNATURE_VERSION = 'v1';

export function mediaSigningSecret(): string {
  const configured = process.env.DAFTARI_MEDIA_SIGNING_SECRET?.trim();
  if (configured && configured.length > 0) return configured;
  // Development fallback: deterministic per data directory so restarts keep
  // previously issued links valid. A deployment must set the env var, or a link
  // issued by one instance would not verify on another.
  return createHash('sha256').update(`daftari-media:${resolveDataDir()}`).digest('hex');
}

function sign(payload: string): string {
  return createHmac('sha256', mediaSigningSecret()).update(payload).digest('base64url');
}

export function createSignedMediaLink(input: { objectKey: string; ttlSeconds: number }): SignedMediaLink {
  const expiresAtMs = Date.now() + input.ttlSeconds * 1000;
  const payload = `${SIGNATURE_VERSION}.${input.objectKey}.${expiresAtMs}`;
  const token = `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`;
  return { token, expiresAt: new Date(expiresAtMs).toISOString() };
}

export function verifySignedMediaLink(token: string): { objectKey: string; expiresAtMs: number } | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = sign(payload);
  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== SIGNATURE_VERSION) return null;
  const objectKey = parts[1];
  const expiresAtMs = Number(parts[2]);
  if (!objectKey || !Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return null;
  return { objectKey, expiresAtMs };
}
