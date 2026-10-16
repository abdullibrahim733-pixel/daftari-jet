/**
 * Private media storage port.
 *
 * Audio is highly sensitive business data: objects live in private storage
 * under opaque keys, are never given public URLs, and are only reachable through
 * short-lived signed links issued after authorization.
 */

export type StoredObject = {
  objectKey: string;
  byteSize: number;
  checksum: string;
};

export type SignedMediaLink = {
  token: string;
  expiresAt: string;
};

export interface MediaStorageAdapter {
  readonly name: string;
  putObject(input: {
    businessId: string;
    bytes: Buffer;
    mediaType: string;
    /** Adapter-specific metadata kept out of the object name. */
    metadata?: Record<string, unknown>;
  }): Promise<StoredObject>;
  readObject(objectKey: string): Promise<Buffer>;
  deleteObject(objectKey: string): Promise<void>;
  createSignedLink(input: { objectKey: string; ttlSeconds: number }): SignedMediaLink;
  verifySignedLink(token: string): { objectKey: string; expiresAtMs: number } | null;
  objectExists(objectKey: string): boolean;
}