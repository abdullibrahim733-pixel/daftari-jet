/**
 * Platform persistence: audit events, transactional outbox, durable jobs,
 * idempotency records and export jobs.
 */

import { createHash } from 'node:crypto';
import { all, get, run, type Db } from '@/server/db/client';
import { newId, nowIso, toJson } from '@/server/db/ids';
import type { TenantScope } from '@/server/business-context/context';
import type { JobStatus, JobType } from '@/server/domain/types';

/* ----------------------------------------------------------- audit events */

export type AuditEventInput = {
  businessId: string;
  actorType: 'user' | 'system';
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string | null;
  reasonCode?: string | null;
  reasonNote?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  source?: 'dashboard' | 'webhook' | 'worker' | 'api';
};

export type AuditEventRow = {
  id: string;
  business_id: string;
  actor_type: 'user' | 'system';
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  event_time: string;
  request_id: string | null;
  reason_code: string | null;
  reason_note: string | null;
  before_json: string | null;
  after_json: string | null;
  source: string;
  integrity_hash: string;
  previous_hash: string | null;
};

/**
 * Appends an audit event chained by hash, so tampering with history is
 * detectable. Only the necessary fields are snapshotted.
 */
export async function appendAuditEvent(db: Db, input: AuditEventInput): Promise<AuditEventRow> {
  const id = newId('aud');
  const eventTime = nowIso();
  const previous = await get<{ integrity_hash: string }>(
    db,
    'SELECT integrity_hash FROM audit_events WHERE business_id = ? ORDER BY event_time DESC, id DESC LIMIT 1',
    [input.businessId],
  );
  const payload = toJson({
    id,
    businessId: input.businessId,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    eventTime,
    reasonCode: input.reasonCode ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
  });
  const integrityHash = createHash('sha256')
    .update(`${previous?.integrity_hash ?? ''}:${payload}`)
    .digest('hex');
  await run(
    db,
    `INSERT INTO audit_events (
       id, business_id, actor_type, actor_user_id, action, entity_type, entity_id,
       event_time, request_id, reason_code, reason_note, before_json, after_json,
       source, integrity_hash, previous_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.businessId,
      input.actorType,
      input.actorUserId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      eventTime,
      input.requestId ?? null,
      input.reasonCode ?? null,
      input.reasonNote ?? null,
      input.before === undefined || input.before === null ? null : toJson(input.before),
      input.after === undefined || input.after === null ? null : toJson(input.after),
      input.source ?? 'dashboard',
      integrityHash,
      previous?.integrity_hash ?? null,
    ],
  );
  return await get<AuditEventRow>(db, 'SELECT * FROM audit_events WHERE id = ?', [id]) as AuditEventRow;
}

export async function listAuditEvents(
  db: Db,
  scope: TenantScope,
  filters: { entityType?: string; entityId?: string; limit: number },
): Promise<(AuditEventRow & { actor_name: string | null })[]> {
  const where: string[] = ['a.business_id = ?'];
  const params: unknown[] = [scope.businessId];
  if (filters.entityType) {
    where.push('a.entity_type = ?');
    params.push(filters.entityType);
  }
  if (filters.entityId) {
    where.push('a.entity_id = ?');
    params.push(filters.entityId);
  }
  return await all<AuditEventRow & { actor_name: string | null }>(
    db,
    `SELECT a.*, u.display_name AS actor_name
     FROM audit_events a
     LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.event_time DESC, a.id DESC
     LIMIT ?`,
    [...params, filters.limit],
  );
}

export async function countAuditEvents(db: Db, scope: TenantScope): Promise<number> {
  const row = await get<{ count: number }>(
    db,
    'SELECT COUNT(*) AS count FROM audit_events WHERE business_id = ?',
    [scope.businessId],
  );
  return row?.count ?? 0;
}

/* ------------------------------------------------------------- outbox */

export async function enqueueOutboxEvent(
  db: Db,
  input: {
    businessId: string | null;
    topic: string;
    entityType?: string | null;
    entityId?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  const id = newId('obx');
  await run(
    db,
    `INSERT INTO outbox_events (
       id, business_id, topic, entity_type, entity_id, payload_json, status, attempts, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      id,
      input.businessId,
      input.topic,
      input.entityType ?? null,
      input.entityId ?? null,
      toJson(input.payload ?? {}),
      nowIso(),
    ],
  );
  return id;
}

/* ----------------------------------------------------------------- jobs */

export type JobRow = {
  id: string;
  business_id: string | null;
  job_type: JobType;
  entity_type: string | null;
  entity_id: string | null;
  idempotency_key: string;
  payload_json: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error_code: string | null;
  provider_correlation_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

/**
 * Enqueues a job unless an identical idempotency key already exists. Queue
 * delivery is at-least-once, so handlers must also be idempotent by entity.
 */
export async function enqueueJob(
  db: Db,
  input: {
    businessId: string | null;
    jobType: JobType;
    idempotencyKey: string;
    entityType?: string | null;
    entityId?: string | null;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
    runAfterIso?: string;
  },
): Promise<JobRow> {
  const existing = await get<JobRow>(db, 'SELECT * FROM jobs WHERE idempotency_key = ?', [input.idempotencyKey]);
  if (existing) return existing;
  const id = newId('job');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO jobs (
       id, business_id, job_type, entity_type, entity_id, idempotency_key, payload_json,
       status, attempts, max_attempts, next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    [
      id,
      input.businessId,
      input.jobType,
      input.entityType ?? null,
      input.entityId ?? null,
      input.idempotencyKey,
      toJson(input.payload ?? {}),
      input.maxAttempts ?? 5,
      input.runAfterIso ?? timestamp,
      timestamp,
      timestamp,
    ],
  );
  return await get<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [id]) as JobRow;
}

/**
 * Recent jobs for one tenant, newest first. Operational history only: the
 * payload is never returned because it can contain provider identifiers.
 */
export async function listRecentJobs(db: Db, scope: TenantScope, limit = 25): Promise<JobRow[]> {
  return await all<JobRow>(
    db,
    `SELECT * FROM jobs
     WHERE business_id = ? AND job_type <> 'delete_expired_media'
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [scope.businessId, limit],
  );
}

export async function claimReadyJobs(db: Db, limit: number, nowIsoValue = nowIso()): Promise<JobRow[]> {
  const candidates = await all<JobRow>(
    db,
    `SELECT * FROM jobs
     WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
     ORDER BY next_attempt_at ASC
     LIMIT ?`,
    [nowIsoValue, limit],
  );
  const claimed: JobRow[] = [];
  for (const job of candidates) {
    const changes = await run(
      db,
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'failed')`,
      [nowIso(), job.id],
    );
    if (changes === 1) {
      claimed.push(await get<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [job.id]) as JobRow);
    }
  }
  return claimed;
}

export async function completeJob(db: Db, jobId: string, providerCorrelationId?: string | null): Promise<void> {
  const timestamp = nowIso();
  await run(
    db,
    `UPDATE jobs SET status = 'succeeded', completed_at = ?, updated_at = ?, last_error_code = NULL,
       provider_correlation_id = COALESCE(?, provider_correlation_id)
     WHERE id = ?`,
    [timestamp, timestamp, providerCorrelationId ?? null, jobId],
  );
}

export async function failJob(
  db: Db,
  jobId: string,
  input: { errorCode: string; retryable: boolean; attempts: number; maxAttempts: number },
): Promise<void> {
  const exhausted = input.attempts >= input.maxAttempts;
  const status: JobStatus = exhausted ? 'dead_letter' : input.retryable ? 'failed' : 'dead_letter';
  const backoffMs = Math.min(60_000, 500 * 2 ** Math.max(0, input.attempts - 1));
  const nextAttempt = new Date(Date.now() + backoffMs).toISOString();
  await run(
    db,
    `UPDATE jobs SET status = ?, last_error_code = ?, next_attempt_at = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`,
    [status, input.errorCode, nextAttempt, nowIso(), exhausted ? nowIso() : null, jobId],
  );
}

export async function recordJobRun(
  db: Db,
  input: {
    jobId: string;
    attempt: number;
    status: 'succeeded' | 'failed';
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    errorCode?: string | null;
    providerRequestId?: string | null;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO job_runs (
       id, job_id, attempt, status, started_at, finished_at, duration_ms, error_code, provider_request_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('run'),
      input.jobId,
      input.attempt,
      input.status,
      input.startedAt,
      input.finishedAt,
      input.durationMs,
      input.errorCode ?? null,
      input.providerRequestId ?? null,
    ],
  );
}

export async function countPendingJobs(db: Db): Promise<number> {
  const row = await get<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending', 'failed')`,
  );
  return row?.count ?? 0;
}

export async function listJobs(db: Db, limit = 50): Promise<JobRow[]> {
  return await all<JobRow>(db, 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', [limit]);
}

/* --------------------------------------------------------- idempotency */

export type IdempotencyRecord = {
  id: string;
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_json: string | null;
  created_at: string;
};

export async function findIdempotencyRecord(db: Db, scope: string, key: string): Promise<IdempotencyRecord | undefined> {
  return await get<IdempotencyRecord>(db, 'SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?', [
    scope,
    key,
  ]);
}

export async function beginIdempotentRequest(
  db: Db,
  scope: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyRecord> {
  await run(
    db,
    `INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status, created_at)
     VALUES (?, ?, ?, ?, 'in_progress', ?)`,
    [newId('idem'), scope, key, requestHash, nowIso()],
  );
  return await findIdempotencyRecord(db, scope, key) as IdempotencyRecord;
}

export async function completeIdempotentRequest(
  db: Db,
  id: string,
  responseStatus: number,
  responseJson: string,
): Promise<void> {
  await run(
    db,
    `UPDATE idempotency_keys SET status = 'completed', response_status = ?, response_json = ? WHERE id = ?`,
    [responseStatus, responseJson, id],
  );
}

/* -------------------------------------------------------------- exports */

export type ExportJobRow = {
  id: string;
  business_id: string;
  requested_by_user_id: string;
  status: 'queued' | 'processing' | 'ready' | 'expired' | 'failed';
  format: 'csv' | 'xlsx';
  from_date: string;
  to_date: string;
  record_types_json: string;
  object_key: string | null;
  row_count: number | null;
  byte_size: number | null;
  failure_code: string | null;
  requested_at: string;
  ready_at: string | null;
  expires_at: string | null;
  downloaded_at: string | null;
};

export async function insertExportJob(
  db: Db,
  input: {
    businessId: string;
    requestedByUserId: string;
    fromDate: string;
    toDate: string;
recordTypes: string[];
    format?: 'csv' | 'xlsx';
  },
): Promise<ExportJobRow> {
  const id = newId('exp');
  await run(
    db,
    `INSERT INTO export_jobs (
       id, business_id, requested_by_user_id, status, format, from_date, to_date,
       record_types_json, requested_at
     ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    [
      id,
      input.businessId,
      input.requestedByUserId,
      input.format ?? 'csv',
      input.fromDate,
      input.toDate,
      toJson(input.recordTypes),
      nowIso(),
    ],
  );
  return await get<ExportJobRow>(db, 'SELECT * FROM export_jobs WHERE id = ?', [id]) as ExportJobRow;
}

export async function findExportJob(db: Db, scope: TenantScope, exportId: string): Promise<ExportJobRow | undefined> {
  return await get<ExportJobRow>(db, 'SELECT * FROM export_jobs WHERE id = ? AND business_id = ?', [
    exportId,
    scope.businessId,
  ]);
}

/**
 * Looks up the export that owns a private object.
 *
 * This is the one lookup without a tenant scope: it is only reachable from a
 * verified signed link, where the signature itself is the authorisation. It
 * still returns the owning business so the caller can confirm the tenant.
 */
export async function findExportJobByObjectKey(db: Db, objectKey: string): Promise<ExportJobRow | undefined> {
  return await get<ExportJobRow>(db, 'SELECT * FROM export_jobs WHERE object_key = ?', [objectKey]);
}

export async function updateExportJob(
  db: Db,
  exportId: string,
  fields: { status?: ExportJobRow['status']; objectKey?: string | null; rowCount?: number; byteSize?: number; readyAt?: string; expiresAt?: string; failureCode?: string },
): Promise<void> {
  const assignments: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    assignments.push(`${column} = ?`);
    params.push(value);
  };
  if (fields.status) push('status', fields.status);
  if (fields.objectKey !== undefined) push('object_key', fields.objectKey);
  if (fields.rowCount !== undefined) push('row_count', fields.rowCount);
  if (fields.byteSize !== undefined) push('byte_size', fields.byteSize);
  if (fields.readyAt) push('ready_at', fields.readyAt);
  if (fields.expiresAt) push('expires_at', fields.expiresAt);
  if (fields.failureCode) push('failure_code', fields.failureCode);
  if (assignments.length === 0) return;
  await run(db, `UPDATE export_jobs SET ${assignments.join(', ')} WHERE id = ?`, [...params, exportId]);
}

export async function markExportDownloaded(db: Db, exportId: string): Promise<void> {
  await run(db, 'UPDATE export_jobs SET downloaded_at = ? WHERE id = ?', [nowIso(), exportId]);
}