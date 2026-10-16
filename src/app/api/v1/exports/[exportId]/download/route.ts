/**
 * Issues a short-lived signed download link for a ready export.
 *
 * The object key never leaves the server: the client receives a signature that
 * the media route exchanges for the bytes, so a leaked link stops working after
 * a few minutes instead of granting permanent access to the ledger.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { tenantScope } from '@/server/business-context/context';
import { assertCan } from '@/server/permissions/policy';
import { findExportJob, markExportDownloaded } from '@/server/repositories/platform.repository';
import { integrations } from '@/server/integrations';
import { notFound, validationFailed } from '@/lib/errors';
import { nowIso } from '@/server/db/ids';
import { ok, route } from '@/server/http/route';

const LINK_TTL_SECONDS = 300;

export const GET = route<{ exportId: string }>(async (_request, { params }) => {
  const { exportId } = await params;
  const { db, context } = await requireTenant();
  assertCan(context.role, 'reports.export');

  const job = await findExportJob(db, tenantScope(context), exportId);
  if (!job) throw notFound('Export not found');
  if (job.status !== 'ready' || !job.object_key) {
    throw validationFailed('This export is not ready to download yet', { status: job.status });
  }
  if (job.expires_at !== null && job.expires_at <= nowIso()) {
    throw validationFailed('This export link has expired. Request the export again.');
  }

  const link = integrations().storage.createSignedLink({
    objectKey: job.object_key,
    ttlSeconds: LINK_TTL_SECONDS,
  });
  await markExportDownloaded(db, exportId);

  return ok({
    exportId: job.id,
    url: `/api/v1/media/download?token=${encodeURIComponent(link.token)}`,
    expiresAt: link.expiresAt,
    fileName: `daftari-${job.from_date}-to-${job.to_date}.${job.format}`,
    rowCount: job.row_count,
    byteSize: job.byte_size,
  });
});
