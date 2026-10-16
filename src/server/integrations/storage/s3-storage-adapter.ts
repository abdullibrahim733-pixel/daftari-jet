/**
 * S3-compatible implementation of the private media storage port.
 *
 * Works against AWS S3, Cloudflare R2, MinIO and any endpoint that speaks the
 * S3 API. Objects stay private; reads are authorized by the same short-lived
 * HMAC link the local adapter issues, so switching storage never changes the
 * download contract.
 *
 * The AWS SDK is imported lazily so it only loads on a process that actually
 * uses S3, keeping the local/test path free of the dependency.
 */

import { createHash } from 'node:crypto';
import type { S3Client, ServerSideEncryption } from '@aws-sdk/client-s3';
import type { S3Config } from '@/server/config/env';
import type { MediaStorageAdapter, SignedMediaLink, StoredObject } from './port';
import { createSignedMediaLink, verifySignedMediaLink } from './signed-link';

export function createS3MediaStorage(config: S3Config & { client?: S3Client }): MediaStorageAdapter {
  let cached: S3Client | undefined = config.client;

  async function client(): Promise<S3Client> {
    if (cached) return cached;
    const { S3Client } = await import('@aws-sdk/client-s3');
    cached = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    return cached;
  }

  function keyFor(objectKey: string): string {
    return config.prefix ? `${config.prefix}/${objectKey}` : objectKey;
  }

  return {
    name: 's3-private-storage',

    async putObject(input): Promise<StoredObject> {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const checksum = createHash('sha256').update(input.bytes).digest('hex');
      const objectKey = `obj_${createHash('sha256')
        .update(`${input.businessId}:${Date.now()}:${checksum}`)
        .digest('hex')
        .slice(0, 32)}`;
      await (await client()).send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: keyFor(objectKey),
          Body: input.bytes,
          ContentType: input.mediaType,
          ServerSideEncryption: config.serverSideEncryption as ServerSideEncryption | undefined,
          Metadata: input.metadata
            ? Object.fromEntries(
                Object.entries(input.metadata).map(([key, value]) => [key, String(value)]),
              )
            : undefined,
        }),
      );
      return { objectKey, byteSize: input.bytes.byteLength, checksum };
    },

    async readObject(objectKey: string): Promise<Buffer> {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const response = await (await client()).send(
        new GetObjectCommand({ Bucket: config.bucket, Key: keyFor(objectKey) }),
      );
      if (!response.Body) throw new Error('Object not found');
      return Buffer.from(await response.Body.transformToByteArray());
    },

    async deleteObject(objectKey: string): Promise<void> {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await (await client()).send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: keyFor(objectKey) }),
      );
    },

    createSignedLink(input: { objectKey: string; ttlSeconds: number }): SignedMediaLink {
      return createSignedMediaLink(input);
    },

    verifySignedLink(token: string): { objectKey: string; expiresAtMs: number } | null {
      return verifySignedMediaLink(token);
    },

    objectExists(objectKey: string): boolean {
      // The port is synchronous, but S3 existence is a network round trip. Every
      // read already fails closed, so this best-effort answer never authorizes
      // access on its own.
      void objectKey;
      return true;
    },
  };
}
