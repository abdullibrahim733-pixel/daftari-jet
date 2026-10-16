/**
 * Records listing.
 *
 * Records are read through the same tenant-scoped query the reports use, so a
 * range filter here and a range filter in a report always mean the same
 * interval. The default range is the current month in the business timezone.
 */

import { requireTenant, tenantOf } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { listLedgerRecords } from '@/server/repositories/ledger.repository';
import { recordManualEntry } from '@/server/services/manual-entry';
import { idempotentResponse, parseIdempotencyKey, withIdempotency } from '@/server/services/idempotency';
import { addDaysToDateStr, dateRangeToUtcMs } from '@/lib/formatting/datetime';
import { rangeFromQuery } from '@/server/http/report-range';
import { ERROR_CODES, conflict, validationFailed } from '@/lib/errors';
import { RECORD_TYPES, type LedgerRecordStatus, type RecordType } from '@/server/domain/types';
import { ok, parseBody, queryInt, queryList, queryParam, route } from '@/server/http/route';
import { manualRecordBodySchema } from '@/server/http/schemas';

function parseTypes(request: Request): RecordType[] | undefined {
  const requested = queryList(request, 'types');
  if (requested.length === 0) return undefined;
  for (const type of requested) {
    if (!(RECORD_TYPES as readonly string[]).includes(type)) {
      throw validationFailed(`Unknown record type: ${type}`, { allowed: [...RECORD_TYPES] });
    }
  }
  return requested as RecordType[];
}

function parseStatuses(request: Request): LedgerRecordStatus[] | undefined {
  const requested = queryList(request, 'statuses');
  if (requested.length === 0) return undefined;
  const allowed: LedgerRecordStatus[] = ['posted', 'voided', 'reversed'];
  for (const status of requested) {
    if (!allowed.includes(status as LedgerRecordStatus)) {
      throw validationFailed(`Unknown record status: ${status}`, { allowed });
    }
  }
  return requested as LedgerRecordStatus[];
}

export const GET = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'records.read');

  const range = rangeFromQuery(request, context.timezone);
  const { fromMs, toExclusiveMs } = dateRangeToUtcMs(range, context.timezone);
  const from = range.from;
  const toInclusive = range.toInclusive ?? addDaysToDateStr(range.toExclusive, -1);

  const limit = queryInt(request, 'limit', 50, 200);
  const cursorAt = queryParam(request, 'cursorOccurredAt');
  const cursorId = queryParam(request, 'cursorId');

  const records = await listLedgerRecords(db, tenantOf(context), {
    fromMs,
    toExclusiveMs,
    types: parseTypes(request),
    statuses: parseStatuses(request),
    customerId: queryParam(request, 'customerId') ?? undefined,
    search: queryParam(request, 'search') ?? undefined,
    limit: limit + 1,
    cursor: cursorAt && cursorId ? { occurredAt: cursorAt, id: cursorId } : null,
  });

  const hasMore = records.length > limit;
  const page = hasMore ? records.slice(0, limit) : records;
  const last = page.at(-1);

  return ok({
    records: page.map((entry) => ({
      id: entry.record.id,
      recordType: entry.record.record_type,
      occurredAt: entry.record.occurred_at,
      currency: entry.record.currency,
      amountMinor: entry.record.amount_minor,
      status: entry.record.status,
      origin: entry.record.origin,
      description: entry.record.description,
      customerId: entry.record.customer_id,
      customerName: entry.customerName,
      confirmedByName: entry.confirmedByName,
      detail: entry.detail,
    })),
    range: { from, to: toInclusive, timezone: context.timezone },
    page: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last ? { occurredAt: last.record.occurred_at, id: last.record.id } : null,
    },
  });
});

/**
 * Records a manual entry.
 *
 * Typing a record is itself the human confirmation, so the entry goes straight
 * through the same validation and deni effects as a reviewed message. The
 * request is idempotent so a double tap cannot post twice.
 */
export const POST = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'records.create_manual');

  const body = await parseBody(request, manualRecordBodySchema);
  const key = parseIdempotencyKey(request.headers.get('idempotency-key'), 'record.manual');
  if (!key) {
    throw validationFailed('This entry needs an Idempotency-Key header', {
      header: 'Idempotency-Key',
      code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    });
  }

  const result = await withIdempotency(
    db,
    { scope: `${key.scope}:${context.businessId}`, key: key.key },
    body,
    async () => {
      const entry = await recordManualEntry(db, context, {
        recordType: body.recordType,
        occurredAt: body.occurredAt,
        fields: body,
        note: body.note ?? null,
      });
      return {
        status: 201,
        body: {
          recordId: entry.confirmation.record.id,
          customerId: entry.confirmation.customer?.id ?? null,
          occurredAt: entry.confirmation.record.occurred_at,
          amountMinor: entry.confirmation.record.amount_minor,
        },
      };
    },
  );

  if (result.kind === 'in_progress') {
    throw conflict(
      ERROR_CODES.IDEMPOTENT_REQUEST_IN_PROGRESS,
      'This entry is still being recorded. Try again in a moment.',
    );
  }
  const response = idempotentResponse(result);
  if (!response) throw conflict(ERROR_CODES.INTERNAL, 'The entry could not be read back');

  return Response.json({ data: response.body }, { status: response.status });
});
