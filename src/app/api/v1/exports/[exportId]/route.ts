/**
 * Export status.
 *
 * The status route is safe to poll: it never returns the object key, so a
 * client cannot build a path to the private file. The download link comes from
 * the separate download route, which issues a short-lived signature.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { tenantScope } from '@/server/business-context/context';
import { assertCan } from '@/server/permissions/policy';
import { findExportJob } from '@/server/repositories/platform.repository';
import { notFound } from '@/lib/errors';
import { ok, route } from '@/server/http/route';

export const GET = route<{ exportId: string }>(async (_request, { params }) => {
  const { exportId } = await params;
  const { db, context } = await requireTenant();
  assertCan(context.role, 'reports.export');

  const job = await findExportJob(db, tenantScope(context), exportId);
  if (!job) throw notFound('Export not found');

  const expired = job.expires_at !== null && job.expires_at <= new Date().toISOString();

  return ok({
    exportId: job.id,
    status: expired && job.status === 'ready' ? 'expired' : job.status,
    format: job.format,
    fromDate: job.from_date,
    toDate: job.to_date,
    recordTypes: JSON.parse(job.record_types_json || '[]') as string[],
    rowCount: job.row_count,
    byteSize: job.byte_size,
    failureCode: job.failure_code,
    requestedAt: job.requested_at,
    readyAt: job.ready_at,
    expiresAt: job.expires_at,
    downloadReady: !expired && job.status === 'ready' && job.object_key !== null,
  });
});
