/**
 * Export service.
 *
 * Exports are jobs, not request/response downloads: the merchant
 * requests an export, the file is generated and stored under a private
 * key, and a short-lived signed link is returned when it is ready.
 * The export contains only the business's own confirmed records.
 */

import type { Db } from '@/server/db/client';
import { nowIso } from '@/server/db/ids';
import { addDaysToDateStr, dateRangeToUtcMs } from '@/lib/formatting/datetime';
import { conflict, notFound, validationFailed } from '@/lib/errors';
import type { BusinessContext } from '@/server/business-context/context';
import { buildXlsx, type XlsxRow } from '../exports/xlsx';
import {
  enqueueJob,
  findExportJob,
  insertExportJob,
  updateExportJob,
  type ExportJobRow,
} from '@/server/repositories/platform.repository';
import { listLedgerRecords, type LedgerRecordWithDetail } from '@/server/repositories/ledger.repository';
import { integrations } from '@/server/integrations';

export type ExportFormat = 'csv' | 'xlsx';

export type ExportRequest = {
  fromDate: string;
  toDate: string;
  recordTypes: string[];
  format: ExportFormat;
};

const ALLOWED_RECORD_TYPES = [
  'sale',
  'expense',
  'debt_created',
  'debt_payment',
  'stock_movement',
  'note',
] as const;

export const EXPORT_COLUMNS = [
  'Record ID',
  'Type',
  'Date (UTC)',
  'Amount (minor units)',
  'Currency',
  'Status',
  'Payment status',
  'Payment method',
  'Category',
  'Customer',
  'Payee',
  'Description',
] as const;

function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function rowValues(record: LedgerRecordWithDetail): unknown[] {
  const detail = record.detail;
  return [
    record.record.id,
    record.record.record_type,
    record.record.occurred_at,
    record.record.amount_minor ?? '',
    record.record.currency,
    record.record.status,
    detail.paymentStatus ?? '',
    detail.paymentMethod ?? '',
    detail.category ?? '',
    record.customerName ?? '',
    detail.payee ?? detail.vendor ?? '',
    record.record.description ?? '',
  ];
}

export function renderCsv(records: LedgerRecordWithDetail[]): string {
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const record of records) {
    lines.push(rowValues(record).map(csvField).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function renderXlsx(records: LedgerRecordWithDetail[]): Buffer {
  const rows: XlsxRow[] = [
    [...EXPORT_COLUMNS],
    ...records.map((record) => rowValues(record) as XlsxRow),
  ];
  return buildXlsx(rows);
}

export function validateExportRequest(input: ExportRequest): void {
  const from = Date.parse(input.fromDate);
  const to = Date.parse(input.toDate);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw validationFailed('Enter a start and end date as YYYY-MM-DD');
  }
  if (to <= from) {
    throw validationFailed('The end date must be after the start date');
  }
  if (to - from > 366 * 86_400_000) {
    throw validationFailed('Exports are limited to one year per request');
  }
  if (input.recordTypes.length === 0 || input.recordTypes.length > ALLOWED_RECORD_TYPES.length) {
    throw validationFailed('Choose which record types to include');
  }
  for (const recordType of input.recordTypes) {
    if (!ALLOWED_RECORD_TYPES.includes(recordType as (typeof ALLOWED_RECORD_TYPES)[number])) {
      throw validationFailed(`Unknown record type: ${recordType}`);
    }
  }
}

/**
 * Records the request and queues the generation.
 *
 * The queue entry is keyed on the export id, so a retried request cannot
 * generate the same file twice, and the row is written before the job so the
 * worker always finds the export it was asked to build.
 */
export async function requestExport(
  db: Db,
  context: BusinessContext,
  input: ExportRequest,
  requestedByUserId: string,
): Promise<ExportJobRow> {
  validateExportRequest(input);
  const job = await insertExportJob(db, {
    businessId: context.businessId,
    requestedByUserId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    recordTypes: input.recordTypes,
    format: input.format,
  });
  await enqueueJob(db, {
    businessId: context.businessId,
    jobType: 'build_export',
    idempotencyKey: `build_export:${job.id}`,
    entityType: 'export',
    entityId: job.id,
    payload: { exportId: job.id, businessId: context.businessId },
  });
  return job;
}

async function recordsForExport(
  db: Db,
  context: BusinessContext,
  job: ExportJobRow,
): Promise<LedgerRecordWithDetail[]> {
  // The stored range is inclusive calendar dates in the business timezone, the
  // same range the reports screen shows, so the file matches what the merchant
  // was looking at when they asked for it.
  const { fromMs, toExclusiveMs } = dateRangeToUtcMs(
    { from: job.from_date, toExclusive: addDaysToDateStr(job.to_date, 1) },
    context.timezone,
  );
  const types = job.record_types_json
    ? (JSON.parse(job.record_types_json) as string[])
    : [];
  const records = await listLedgerRecords(
    db,
    { businessId: context.businessId },
    {
      fromMs,
      toExclusiveMs,
      limit: 10_000,
    },
  );
  return records.filter(
    (record) => types.length === 0 || types.includes(record.record.record_type),
  );
}

/**
 * Generates the export file. Called by the export job handler and by
 * the dev simulator; safe to re-run because the file is replaced.
 *
 * The file goes through the storage port rather than a bespoke directory, so
 * the object key stored on the export row is exactly the key the download route
 * later reads back. Writing them through different paths is how an export ends
 * up "ready" but undownloadable.
 */
export async function generateExport(
  db: Db,
  context: BusinessContext,
  exportId: string,
): Promise<ExportJobRow> {
  const job = await findExportJob(db, { businessId: context.businessId }, exportId);
  if (!job) throw notFound('Export not found');
  if (job.status === 'processing') throw conflict('EXPORT_IN_PROGRESS', 'This export is already being generated');

  await updateExportJob(db, exportId, { status: 'processing' });
  try {
    const records = await recordsForExport(db, context, job);
    const content =
      job.format === 'xlsx'
        ? renderXlsx(records)
        : Buffer.from(renderCsv(records), 'utf8');
    const stored = await integrations().storage.putObject({
      businessId: context.businessId,
      bytes: content,
      mediaType:
        job.format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv',
      metadata: { exportId: job.id, format: job.format },
    });
    const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
    await updateExportJob(db, exportId, {
      status: 'ready',
      objectKey: stored.objectKey,
      rowCount: records.length,
      byteSize: stored.byteSize,
      readyAt: nowIso(),
      expiresAt,
    });
  } catch (error) {
    await updateExportJob(db, exportId, {
      status: 'failed',
      failureCode: error instanceof Error ? error.message.slice(0, 120) : 'export_failed',
    });
    throw error;
  }
  return await findExportJob(db, { businessId: context.businessId }, exportId) as ExportJobRow;
}

/** Removes a finished export file, e.g. after expiry. */
export async function discardExportFile(objectKey: string): Promise<void> {
  await integrations().storage.deleteObject(objectKey);
}
