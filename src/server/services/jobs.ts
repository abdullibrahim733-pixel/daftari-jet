/**
 * Durable job runner.
 *
 * Jobs are claimed atomically (single UPDATE that flips the row's
 * status), executed with their own job run record, and failed with an
 * exponential backoff. Handlers are idempotent by entity, because the
 * queue is at-least-once.
 */

import { type Db, getDatabase } from '@/server/db/client';
import { nowIso } from '@/server/db/ids';
import {
  claimReadyJobs,
  completeJob,
  enqueueJob,
  failJob,
  recordJobRun,
  type JobRow,
} from '@/server/repositories/platform.repository';
import { listExpiredMedia, markMediaDeleted } from '@/server/repositories/source.repository';
import { integrations } from '@/server/integrations';
import { processSourceEvent } from './pipeline';
import { acquireMediaForSourceEvent } from './media-acquisition';
import { generateExport } from './exports';
import { businessContextForJob } from './context-builder';
import { logger } from '@/server/observability/logger';

export type JobRunSummary = {
  jobId: string;
  jobType: string;
  status: 'succeeded' | 'failed' | 'dead_letter';
  errorCode?: string;
};

function isRetryableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ('retryable' in error && (error as { retryable?: boolean }).retryable === true)
  );
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  if (error instanceof Error) return error.message.slice(0, 120) || 'unknown_error';
  return 'unknown_error';
}

async function executeJob(db: Db, job: JobRow): Promise<void> {
  switch (job.job_type) {
    case 'acquire_media': {
      const payload = job.payload_json
        ? (JSON.parse(job.payload_json) as { sourceEventId: string })
        : null;
      if (!job.business_id || !payload?.sourceEventId) {
        throw Object.assign(new Error('Media acquisition is missing its sourceEventId'), {
          code: 'bad_payload',
          retryable: false,
        });
      }
      const context = await businessContextForJob(db, job.business_id);
      const outcome = await acquireMediaForSourceEvent(db, context, payload.sourceEventId);
      if (outcome.kind === 'failed') {
        throw Object.assign(new Error(outcome.code), {
          code: outcome.code,
          retryable: outcome.retryable,
        });
      }
      // Only once the media is durably stored can transcription run; an
      // already-acquired event still needs its transcription enqueued.
      await enqueueTranscription(db, job.business_id, payload.sourceEventId);
      return;
    }
    case 'transcribe_source': {
      const payload = job.payload_json
        ? (JSON.parse(job.payload_json) as { sourceEventId: string })
        : null;
      if (!payload?.sourceEventId) {
        throw Object.assign(new Error('Job payload is missing sourceEventId'), {
          code: 'bad_payload',
          retryable: false,
        });
      }
      const context = await businessContextForJob(db, job.business_id);
      const outcome = await processSourceEvent(db, context, payload.sourceEventId);
      if (outcome.kind === 'failed') {
        throw Object.assign(new Error(outcome.failureCode), {
          code: outcome.failureCode,
          retryable: outcome.retryable,
        });
      }
      return;
    }
    case 'delete_expired_media': {
      // Retention is always tenant-scoped: an unscoped job must never reach
      // another business's files, so it dead-letters instead of guessing.
      if (!job.business_id) {
        throw Object.assign(new Error('Retention job is missing its businessId'), {
          code: 'bad_payload',
          retryable: false,
        });
      }
      const deps = integrations();
      const expired = await listExpiredMedia(db, { businessId: job.business_id });
      for (const media of expired) {
        await deps.storage.deleteObject(media.object_key);
        await markMediaDeleted(db, media.id);
      }
      return;
    }
    case 'build_export': {
      const payload = job.payload_json
        ? (JSON.parse(job.payload_json) as { exportId: string })
        : null;
      if (!job.business_id || !payload?.exportId) {
        throw Object.assign(new Error('Export job is missing its exportId'), {
          code: 'bad_payload',
          retryable: false,
        });
      }
      // The worker builds the file for real; without this an export requested in
      // the dashboard would sit in "queued" forever.
      const context = await businessContextForJob(db, job.business_id);
      await generateExport(db, context, payload.exportId);
      return;
    }
    case 'provider_health_check': {
      // Mock adapters have no external endpoint to poll; a real provider
      // adapter implements this check.
      return;
    }
    default:
      throw Object.assign(new Error(`Job type ${job.job_type} is not runnable`), {
        code: 'unknown_job_type',
        retryable: false,
      });
  }
}

/** Runs one claimed job, recording its attempt and outcome. */
async function runJob(db: Db, job: JobRow): Promise<JobRunSummary> {
  const startedAt = nowIso();
  const startMs = Date.now();
  try {
    await executeJob(db, job);
    const finishedAt = nowIso();
    await recordJobRun(db, {
      jobId: job.id,
      attempt: job.attempts,
      status: 'succeeded',
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
    });
    await completeJob(db, job.id);
    return { jobId: job.id, jobType: job.job_type, status: 'succeeded' };
  } catch (error) {
    const finishedAt = nowIso();
    const code = errorCode(error);
    const retryable = isRetryableError(error);
    await recordJobRun(db, {
      jobId: job.id,
      attempt: job.attempts,
      status: 'failed',
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      errorCode: code,
    });
    await failJob(db, job.id, {
      errorCode: code,
      retryable,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
    });
    const exhausted = job.attempts >= job.max_attempts;
    logger.warn('job.failed', {
      jobId: job.id,
      jobType: job.job_type,
      errorCode: code,
      retryable,
      attempts: job.attempts,
    });
    return {
      jobId: job.id,
      jobType: job.job_type,
      status: exhausted || !retryable ? 'dead_letter' : 'failed',
      errorCode: code,
    };
  }
}

/** Claims and executes due jobs. Returns per-job outcomes. */
export async function runDueJobs(
  db: Db = getDatabase(),
  options: { limit?: number } = {},
): Promise<JobRunSummary[]> {
  const limit = options.limit ?? 20;
  const jobs = await claimReadyJobs(db, limit);
  const summaries: JobRunSummary[] = [];
  for (const job of jobs) {
    summaries.push(await runJob(db, job));
  }
  return summaries;
}

/** Enqueues transcription for a source event exactly once. */
export async function enqueueTranscription(db: Db, businessId: string, sourceEventId: string): Promise<void> {
  await enqueueJob(db, {
    businessId,
    jobType: 'transcribe_source',
    idempotencyKey: `transcribe:${sourceEventId}`,
    entityType: 'source_event',
    entityId: sourceEventId,
    payload: { sourceEventId, businessId },
  });
}

/**
 * Enqueues download-and-store for provider-hosted media exactly once.
 *
 * Separate from enqueueTranscription so a provider delivery that only carries a
 * media reference is stored before the pipeline can see an empty transcript.
 */
export async function enqueueMediaAcquisition(
  db: Db,
  businessId: string,
  sourceEventId: string,
): Promise<void> {
  await enqueueJob(db, {
    businessId,
    jobType: 'acquire_media',
    idempotencyKey: `acquire:${sourceEventId}`,
    entityType: 'source_event',
    entityId: sourceEventId,
    payload: { sourceEventId, businessId },
  });
}
