/**
 * Job history for the current tenant.
 *
 * Operational history helps a merchant see why a message is still waiting, so
 * it exposes the state and the failure code but never the provider payload.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { tenantScope } from '@/server/business-context/context';
import { assertCan } from '@/server/permissions/policy';
import { listRecentJobs } from '@/server/repositories/platform.repository';
import type { JobStatus } from '@/server/domain/types';
import { ok, queryEnum, queryInt, route } from '@/server/http/route';

const JOB_STATUSES: readonly JobStatus[] = ['pending', 'running', 'succeeded', 'failed', 'dead_letter'];

export const GET = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'dashboard.read');

  const limit = queryInt(request, 'limit', 25, 100);
  const statusFilter = queryEnum(request, 'status', JOB_STATUSES);

  const jobs = await listRecentJobs(db, tenantScope(context), limit);
  const filtered = statusFilter ? jobs.filter((job) => job.status === statusFilter) : jobs;

  return ok({
    jobs: filtered.map((job) => ({
      id: job.id,
      type: job.job_type,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      lastErrorCode: job.last_error_code,
      nextAttemptAt: job.next_attempt_at,
      createdAt: job.created_at,
      completedAt: job.completed_at,
    })),
    page: { limit, total: filtered.length },
  });
});
