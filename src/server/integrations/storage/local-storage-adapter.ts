/**
 * Local filesystem implementation of the private media storage port.
 *
 * Objects are stored under an opaque key inside the private data directory.
 * Every read is authorised first, then authorised again by a short-lived HMAC
 * signature, so an object key alone is never sufficient to read audio.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '@/server/db/client';
import type { MediaStorageAdapter, SignedMediaLink, StoredObject } from './port';
import { createSignedMediaLink, verifySignedMediaLink } from './signed-link';

function mediaRoot(): string {
  return path.join(resolveDataDir(), 'media');
}

function objectPath(objectKey: string): string {
  const safe = objectKey.replace(/[^A-Za-z0-9._-]/g, '');
  if (safe.length === 0) throw new Error('Invalid object key');
  return path.join(mediaRoot(), safe);
}

export const localMediaStorage: MediaStorageAdapter = {
  name: 'local-private-storage',

  async putObject(input): Promise<StoredObject> {
    mkdirSync(mediaRoot(), { recursive: true });
    const objectKey = `obj_${createHash('sha256')
      .update(`${input.businessId}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 32)}`;
    const target = objectPath(objectKey);
    writeFileSync(target, input.bytes, { mode: 0o600 });
    return {
      objectKey,
      byteSize: input.bytes.byteLength,
      checksum: createHash('sha256').update(input.bytes).digest('hex'),
    };
  },

  async readObject(objectKey: string): Promise<Buffer> {
    const target = objectPath(objectKey);
    if (!existsSync(target)) throw new Error('Object not found');
    return readFileSync(target);
  },

  async deleteObject(objectKey: string): Promise<void> {
    const target = objectPath(objectKey);
    if (existsSync(target)) rmSync(target, { force: true });
  },

  createSignedLink(input: { objectKey: string; ttlSeconds: number }): SignedMediaLink {
    return createSignedMediaLink(input);
  },

  verifySignedLink(token: string): { objectKey: string; expiresAtMs: number } | null {
    return verifySignedMediaLink(token);
  },

  objectExists(objectKey: string): boolean {
    return existsSync(objectPath(objectKey));
  },
};

export function exportRoot(): string {
  return path.join(resolveDataDir(), 'exports');
}

export function writePrivateFile(relativeName: string, bytes: Buffer): { objectKey: string; byteSize: number } {
  mkdirSync(exportRoot(), { recursive: true });
  const target = path.join(exportRoot(), relativeName.replace(/[^A-Za-z0-9._-]/g, '_'));
  writeFileSync(target, bytes, { mode: 0o600 });
  return { objectKey: `exp_${path.basename(target)}`, byteSize: bytes.byteLength };
}

export function readPrivateFile(objectKey: string): Buffer | null {
  const target = path.join(exportRoot(), path.basename(objectKey));
  if (!existsSync(target)) return null;
  return readFileSync(target);
}

export function deletePrivateFile(objectKey: string): void {
  const target = path.join(exportRoot(), path.basename(objectKey));
  if (existsSync(target)) rmSync(target, { force: true });
}