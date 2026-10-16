/**
 * Vercel Blob implementation of the private media storage port.
 *
 * Selected when `DAFTARI_STORAGE_PROVIDER=blob`. Objects live in a private Blob
 * store, are never given public URLs, and reads are authorized by the same
 * short-lived HMAC link the local and S3 adapters issue, so the download contract
 * never changes with the backend.
 *
 * On Vercel the SDK authenticates with OIDC: it pairs the `BLOB_STORE_ID`
 * environment variable (added when the store is connected to the project) with
 * the short-lived `VERCEL_OIDC_TOKEN`, which Vercel issues and rotates for us.
 *
 * The SDK is imported lazily so a process that uses local or S3 storage never
 * loads it, keeping local/test free of the dependency.
 */

import { createHash } from 'node:crypto';
import type { MediaStorageAdapter, SignedMediaLink, StoredObject } from './port';
import { createSignedMediaLink, verifySignedMediaLink } from './signed-link';

export function createVercelBlobStorage(storeId: string): MediaStorageAdapter {
  return {
    name: 'vercel-blob-private-storage',

    async putObject(input): Promise<StoredObject> {
      const { put } = await import('@vercel/blob');
      const checksum = createHash('sha256').update(input.bytes).digest('hex');
      const objectKey = `obj_${createHash('sha256')
        .update(`${input.businessId}:${Date.now()}:${checksum}`)
        .digest('hex')
        .slice(0, 32)}`;
      await put(objectKey, input.bytes, {
        access: 'private',
        contentType: input.mediaType,
        addRandomSuffix: false,
        storeId,
      });
      return { objectKey, byteSize: input.bytes.byteLength, checksum };
    },

    async readObject(objectKey: string): Promise<Buffer> {
      const { get } = await import('@vercel/blob');
      const result = await get(objectKey, { access: 'private', storeId });
      if (!result || result.statusCode !== 200 || !result.stream) {
        throw new Error('Object not found');
      }
      return Buffer.from(await new Response(result.stream).arrayBuffer());
    },

    async deleteObject(objectKey: string): Promise<void> {
      const { del } = await import('@vercel/blob');
      await del(objectKey, { storeId });
    },

    createSignedLink(input: { objectKey: string; ttlSeconds: number }): SignedMediaLink {
      return createSignedMediaLink(input);
    },

    verifySignedLink(token: string): { objectKey: string; expiresAtMs: number } | null {
      return verifySignedMediaLink(token);
    },

    objectExists(objectKey: string): boolean {
      // The port is synchronous, but Blob existence is a network round trip.
      // Every read already fails closed, so this best-effort answer never
      // authorizes access on its own.
      void objectKey;
      return true;
    },
  };
}
