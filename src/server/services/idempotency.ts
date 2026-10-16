/**
 * Request idempotency for mutating endpoints.
 *
 * A client that retries a POST with the same `Idempotency-Key` and the
 * same request body gets the original response back instead of a second
 * write. A key reused with a *different* body is a conflict, because
 * silently ignoring the new body would corrupt the caller's intent.
 */

import { createHash } from 'node:crypto';
import { withTransaction, type Db } from '@/server/db/client';
import {
  beginIdempotentRequest,
  completeIdempotentRequest,
  findIdempotencyRecord,
  type IdempotencyRecord,
} from '@/server/repositories/platform.repository';
import { conflict, ERROR_CODES } from '@/lib/errors';

export type IdempotencyKey = { scope: string; key: string };

export function parseIdempotencyKey(
  header: string | null | undefined,
  scope: string,
): IdempotencyKey | null {
  const key = header?.trim();
  if (!key || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) return null;
  return { scope, key };
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export type IdempotentResult<T> =
  | { kind: 'replayed'; status: number; body: T }
  | { kind: 'executed'; record: IdempotencyRecord }
  | { kind: 'in_progress' };

/**
 * Executes `work` once per (scope, key, request hash). The response is
 * stored inside the same transaction as the work, so a crash can never
 * leave a completed write without its replayable response.
 */
export async function withIdempotency<T>(
  db: Db,
  key: IdempotencyKey,
  body: unknown,
  work: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {  const hash = requestHash(body);
  const existing = await findIdempotencyRecord(db, key.scope, key.key);
  if (existing?.status === 'completed') {
    if (existing.request_hash !== hash) {
      throw conflict(
        ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        'This idempotency key was used with a different request',
      );
    }
    const replayed = existing.response_json
      ? (JSON.parse(existing.response_json) as { status: number; body: T })
      : { status: 200, body: null as T };
    return { kind: 'replayed', status: replayed.status, body: replayed.body };
  }
  if (existing?.status === 'in_progress') {
    if (existing.request_hash !== hash) {
      throw conflict(
        ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        'This idempotency key is in progress with a different request',
      );
    }
    return { kind: 'in_progress' };
  }

  // The work and the response that makes it replayable commit together:
  // a crash can never leave a write whose response is unrecoverable, and
  // a rollback never leaves an in-progress key that blocks the retry.
  const executed = await withTransaction(async () => {
    const record = await beginIdempotentRequest(db, key.scope, key.key, hash);
    const response = await work();
    await completeIdempotentRequest(db, record.id, response.status, JSON.stringify(response));
    return { record, response };
  }, db);
  return { kind: 'executed', record: executed.record };
}

/**
 * Collapses both outcomes into the response the caller should send, so a route
 * does not have to care whether the work just ran or was replayed.
 */
export function idempotentResponse<T>(
  result: IdempotentResult<T>,
): { status: number; body: T } | null {
  if (result.kind === 'replayed') return { status: result.status, body: result.body };
  if (result.kind === 'in_progress') return null;
  const stored = result.record.response_json
    ? (JSON.parse(result.record.response_json) as { status: number; body: T })
    : { status: 200, body: null as T };
  return { status: result.record.response_status ?? stored.status, body: stored.body };
}
