/**
 * Audit service.
 *
 * Every state change that a merchant can see or dispute passes through here.
 * Callers supply the tenant explicitly: there is no ambient business id, because
 * an audit trail that can inherit the wrong tenant is worse than no trail.
 */

import { withTransaction, type Db } from '@/server/db/client';
import { appendAuditEvent, type AuditEventRow } from '@/server/repositories/platform.repository';
import type { AuditAction } from '@/server/domain/types';
import { logger } from '@/server/observability/logger';

export type { AuditAction };

export type AuditInput = {
  businessId: string;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  actorType?: 'user' | 'system';
  requestId?: string | null;
  reasonCode?: string | null;
  reasonNote?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  source?: 'dashboard' | 'webhook' | 'worker' | 'api';
};

/** Records one audit event. Call inside an outer transaction when one exists. */
export async function recordAudit(db: Db, input: AuditInput): Promise<AuditEventRow> {
  return await appendAuditEvent(db, {
    businessId: input.businessId,
    actorType: input.actorType ?? (input.actorUserId ? 'user' : 'system'),
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    requestId: input.requestId ?? null,
    reasonCode: input.reasonCode ?? null,
    reasonNote: input.reasonNote ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    source: input.source ?? 'dashboard',
  });
}

/**
 * Audit recording must never roll back the business change it describes, so a
 * failure here is logged rather than thrown. The state change stays the source
 * of truth; the gap is visible in the logs.
 */
export async function recordAuditSafely(db: Db, input: AuditInput): Promise<AuditEventRow | null> {
  try {
    return await recordAudit(db, input);
  } catch (error) {
    logger.error('audit.append_failed', {
      businessId: input.businessId,
      action: input.action,
      entityId: input.entityId ?? undefined,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

export async function recordAuditInTransaction<T>(
  db: Db,
  input: AuditInput,
  work: () => T | Promise<T>,
): Promise<T> {
  return await withTransaction(async () => {
    const result = await work();
    await recordAuditSafely(db, input);
    return result;
  }, db);
}
