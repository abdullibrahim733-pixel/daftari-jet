/**
 * Streams a private object against a signed token.
 *
 * The signature, not a session cookie, is the authorisation here: the token
 * already proves which object may be read and until when. The lookup is still
 * tenant-scoped so a token can never reach another business' file.
 */

import { integrations } from '@/server/integrations';
import { findExportJobByObjectKey } from '@/server/repositories/platform.repository';
import { getDatabase } from '@/server/db/client';
import { notFound, signatureInvalid } from '@/lib/errors';
import { queryParam, route } from '@/server/http/route';

const CONTENT_TYPES: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const GET = route(async (request) => {
  const token = queryParam(request, 'token');
  if (!token) throw signatureInvalid('A download token is required');

  const storage = integrations().storage;
  const verified = storage.verifySignedLink(token);
  if (!verified) throw signatureInvalid('This download link is invalid or has expired');

  // The signed token proves which object may be read; the job row proves that
  // object belongs to a real export of a real tenant.
  const job = await findExportJobByObjectKey(getDatabase(), verified.objectKey);
  if (!job) throw notFound('Export not found');

  const bytes = await storage.readObject(job.object_key as string);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': CONTENT_TYPES[job.format] ?? 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="daftari-${job.from_date}-to-${job.to_date}.${job.format}"`,
    },
  });
});
