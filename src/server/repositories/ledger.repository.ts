/**
 * Confirmed ledger persistence.
 *
 * Only confirmed records live here. Corrections create a new version row with
 * before/after values instead of overwriting history, and totals are always
 * computed from `status = 'posted'` rows.
 */

import { all, get, run, type Db } from '@/server/db/client';
import { isoFromMs, newId, nowIso, toJson } from '@/server/db/ids';
import type { TenantScope } from '@/server/business-context/context';
import type {
  LedgerRecordStatus,
  MovementType,
  PaymentMethod,
  PaymentStatus,
  RecordType,
} from '@/server/domain/types';

export type LedgerRecordRow = {
  id: string;
  business_id: string;
  record_type: RecordType;
  occurred_at: string;
  currency: string;
  amount_minor: number | null;
  description: string | null;
  customer_id: string | null;
  payee_name: string | null;
  status: LedgerRecordStatus;
  origin: 'whatsapp' | 'manual' | 'import';
  source_event_id: string | null;
  proposal_id: string | null;
  created_by_user_id: string;
  confirmed_at: string;
  version: number;
  supersedes_record_id: string | null;
  reverses_record_id: string | null;
  created_at: string;
  updated_at: string;
};

export type LedgerVersionRow = {
  id: string;
  business_id: string;
  ledger_record_id: string;
  version: number;
  snapshot_json: string;
  change_kind: 'created' | 'corrected' | 'reversed' | 'voided';
  reason_code: string | null;
  reason_note: string | null;
  actor_user_id: string;
  created_at: string;
};

export type LedgerDetail = {
  paymentStatus?: PaymentStatus;
  paymentMethod?: PaymentMethod;
  externalReference?: string | null;
  category?: string;
  payee?: string | null;
  vendor?: string | null;
  items: { description: string; quantityMilli: number; unit: string; lineAmountMinor: number | null }[];
  itemId?: string | null;
  quantityMilli?: number | null;
  unit?: string | null;
  movementType?: MovementType | null;
  unitCostMinor?: number | null;
  note?: string | null;
};

export type LedgerRecordWithDetail = {
  record: LedgerRecordRow;
  detail: LedgerDetail;
  customerName: string | null;
  confirmedByName: string | null;
};

export type InsertLedgerRecordInput = {
  businessId: string;
  recordType: RecordType;
  occurredAt: string;
  currency: string;
  amountMinor: number | null;
  description: string | null;
  customerId: string | null;
  payeeName: string | null;
  origin: 'whatsapp' | 'manual' | 'import';
  sourceEventId: string | null;
  proposalId: string | null;
  createdByUserId: string;
  detail: LedgerDetail;
  reversesRecordId?: string | null;
};

export async function insertLedgerRecord(db: Db, input: InsertLedgerRecordInput): Promise<LedgerRecordRow> {
  const id = newId('led');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO ledger_records (
       id, business_id, record_type, occurred_at, currency, amount_minor, description,
       customer_id, payee_name, status, origin, source_event_id, proposal_id,
       created_by_user_id, confirmed_at, version, supersedes_record_id, reverses_record_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`,
    [
      id,
      input.businessId,
      input.recordType,
      input.occurredAt,
      input.currency,
      input.amountMinor,
      input.description,
      input.customerId,
      input.payeeName,
      input.origin,
      input.sourceEventId,
      input.proposalId,
      input.createdByUserId,
      timestamp,
      input.reversesRecordId ?? null,
      timestamp,
      timestamp,
    ],
  );
  await writeTypedDetail(db, { ledgerRecordId: id, businessId: input.businessId, recordType: input.recordType, detail: input.detail });
  await insertLedgerVersion(db, {
    businessId: input.businessId,
    ledgerRecordId: id,
    version: 1,
    snapshot: await snapshotOf(db, id),
    changeKind: 'created',
    actorUserId: input.createdByUserId,
  });
  return await get<LedgerRecordRow>(db, 'SELECT * FROM ledger_records WHERE id = ?', [id]) as LedgerRecordRow;
}

async function writeTypedDetail(
  db: Db,
  input: { ledgerRecordId: string; businessId: string; recordType: RecordType; detail: LedgerDetail },
): Promise<void> {
  const { detail } = input;
  const timestamp = nowIso();
  if (input.recordType === 'sale') {
    await run(
      db,
      `INSERT INTO sales (ledger_record_id, business_id, payment_status, payment_method, external_reference, paid_at, category)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.ledgerRecordId,
        input.businessId,
        detail.paymentStatus ?? 'unknown',
        detail.paymentMethod ?? 'unknown',
        detail.externalReference ?? null,
        (detail.paymentStatus ?? 'unknown') === 'paid' ? timestamp : null,
        detail.category ?? null,
      ],
    );
  }
  if (input.recordType === 'expense') {
    await run(
      db,
      'INSERT INTO expenses (ledger_record_id, business_id, category, vendor) VALUES (?, ?, ?, ?)',
      [
        input.ledgerRecordId,
        input.businessId,
        detail.category ?? 'other',
        detail.payee ?? detail.vendor ?? null,
      ],
    );
  }
  if (input.recordType === 'note') {
    await run(
      db,
      'INSERT INTO business_notes (ledger_record_id, business_id, note, privacy_classification) VALUES (?, ?, ?, ?)',
      [input.ledgerRecordId, input.businessId, detail.note ?? '', 'confidential_business'],
    );
  }
  for (const item of detail.items) {    await run(
      db,
      `INSERT INTO line_items (
         id, business_id, ledger_record_id, description, item_id, quantity_milli, unit,
         unit_price_minor, line_amount_minor, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('lin'),
        input.businessId,
        input.ledgerRecordId,
        item.description,
        detail.itemId ?? null,
        item.quantityMilli,
        item.unit,
        null,
        item.lineAmountMinor,
        timestamp,
      ],
    );
  }
}

export async function findLedgerRecordById(
  db: Db,
  scope: TenantScope,
  recordId: string,
): Promise<LedgerRecordRow | undefined> {
  return await get<LedgerRecordRow>(db, 'SELECT * FROM ledger_records WHERE id = ? AND business_id = ?', [
    recordId,
    scope.businessId,
  ]);
}

export async function findLedgerRecordByProposal(
  db: Db,
  scope: TenantScope,
  proposalId: string,
): Promise<LedgerRecordRow | undefined> {
  return await get<LedgerRecordRow>(db, 'SELECT * FROM ledger_records WHERE business_id = ? AND proposal_id = ?', [
    scope.businessId,
    proposalId,
  ]);
}

export async function readTypedDetail(db: Db, record: LedgerRecordRow): Promise<LedgerDetail> {
  const detail: LedgerDetail = { items: [] };
  if (record.record_type === 'sale') {
    const sale = await get<{
      payment_status: PaymentStatus;
      payment_method: PaymentMethod;
      external_reference: string | null;
      category: string | null;
    }>(db, 'SELECT * FROM sales WHERE ledger_record_id = ?', [record.id]);
    if (sale) {
      detail.paymentStatus = sale.payment_status;
      detail.paymentMethod = sale.payment_method;
      detail.externalReference = sale.external_reference;
      detail.category = sale.category ?? 'uncategorised';
    }
  }
  if (record.record_type === 'expense') {
    const expense = await get<{ category: string; vendor: string | null }>(
      db,
      'SELECT * FROM expenses WHERE ledger_record_id = ?',
      [record.id],
    );
    if (expense) {
      detail.category = expense.category;
      detail.vendor = expense.vendor;
    }
  }
  if (record.record_type === 'note') {
    const note = await get<{ note: string }>(db, 'SELECT * FROM business_notes WHERE ledger_record_id = ?', [
      record.id,
    ]);
    if (note) detail.note = note.note;
  }
  const items = await all<{ description: string; quantity_milli: number; unit: string; line_amount_minor: number | null }>(
    db,
    'SELECT description, quantity_milli, unit, line_amount_minor FROM line_items WHERE ledger_record_id = ?',
    [record.id],
  );
  detail.items = items.map((item) => ({
    description: item.description,
    quantityMilli: item.quantity_milli,
    unit: item.unit,
    lineAmountMinor: item.line_amount_minor,
  }));
  if (record.record_type === 'stock_movement') {
    const movement = await get<{
      item_id: string;
      movement_type: MovementType;
      quantity_milli: number;
      unit_cost_minor: number | null;
      note: string | null;
    }>(db, 'SELECT * FROM inventory_movements WHERE ledger_record_id = ?', [record.id]);
    if (movement) {
      detail.itemId = movement.item_id;
      detail.movementType = movement.movement_type;
      detail.quantityMilli = Math.abs(movement.quantity_milli);
      detail.unitCostMinor = movement.unit_cost_minor;
      detail.note = movement.note;
      const item = await get<{ unit: string }>(db, 'SELECT unit FROM inventory_items WHERE id = ?', [movement.item_id]);
      detail.unit = item?.unit ?? 'unit';
    }
  }
  return detail;
}

export async function hydrateLedgerRecord(db: Db, record: LedgerRecordRow): Promise<LedgerRecordWithDetail> {
  const customer = record.customer_id
    ? await get<{ display_name: string }>(db, 'SELECT display_name FROM customers WHERE id = ?', [record.customer_id])
    : undefined;
  const confirmer = await get<{ display_name: string }>(db, 'SELECT display_name FROM users WHERE id = ?', [
    record.created_by_user_id,
  ]);
  return {
    record,
    detail: await readTypedDetail(db, record),
    customerName: customer?.display_name ?? null,
    confirmedByName: confirmer?.display_name ?? null,
  };
}

export async function listLedgerRecords(
  db: Db,
  scope: TenantScope,
  filters: {
    fromMs: number;
    toExclusiveMs: number;
    types?: RecordType[];
    statuses?: LedgerRecordStatus[];
    origins?: ('whatsapp' | 'manual' | 'import')[];
    customerId?: string;
    search?: string;
    limit: number;
    cursor?: { occurredAt: string; id: string } | null;
  },
): Promise<LedgerRecordWithDetail[]> {
  const where: string[] = [
    'r.business_id = ?',
    'r.occurred_at >= ?',
    'r.occurred_at < ?',
  ];
  const params: unknown[] = [scope.businessId, isoFromMs(filters.fromMs), isoFromMs(filters.toExclusiveMs)];
  if (filters.types && filters.types.length > 0) {
    where.push(`r.record_type IN (${filters.types.map(() => '?').join(', ')})`);
    params.push(...filters.types);
  }
  if (filters.statuses && filters.statuses.length > 0) {
    where.push(`r.status IN (${filters.statuses.map(() => '?').join(', ')})`);
    params.push(...filters.statuses);
  }
  if (filters.origins && filters.origins.length > 0) {
    where.push(`r.origin IN (${filters.origins.map(() => '?').join(', ')})`);
    params.push(...filters.origins);
  }
  if (filters.customerId) {
    where.push('r.customer_id = ?');
    params.push(filters.customerId);
  }
  if (filters.search) {
    where.push('(r.description LIKE ? OR r.payee_name LIKE ? OR c.display_name LIKE ?)');
    const pattern = `%${filters.search}%`;
    params.push(pattern, pattern, pattern);
  }
  if (filters.cursor) {
    where.push('(r.occurred_at < ? OR (r.occurred_at = ? AND r.id < ?))');
    params.push(filters.cursor.occurredAt, filters.cursor.occurredAt, filters.cursor.id);
  }
  const rows = await all<LedgerRecordRow>(
    db,
    `SELECT r.* FROM ledger_records r
     LEFT JOIN customers c ON c.id = r.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY r.occurred_at DESC, r.id DESC
     LIMIT ?`,
    [...params, filters.limit],
  );
  return Promise.all(rows.map(async (row) => hydrateLedgerRecord(db, row)));
}

/** Period totals used by the overview, KPI cards and reports. */
export type PeriodTotals = {
  salesRecordedMinor: number;
  salesReceivedMinor: number;
  expensesMinor: number;
  debtPaymentsReceivedMinor: number;
  debtCreatedMinor: number;
  moneyInMinor: number;
  moneyOutMinor: number;
  netCashMovementMinor: number;
  confirmedCount: number;
  saleCount: number;
  expenseCount: number;
};

export async function periodTotals(db: Db, scope: TenantScope, fromMs: number, toExclusiveMs: number): Promise<PeriodTotals> {
  const rows = await all<{
    record_type: RecordType;
    amount_minor: number | null;
    payment_status: PaymentStatus | null;
  }>(
    db,
    `SELECT r.record_type, r.amount_minor, s.payment_status
     FROM ledger_records r
     LEFT JOIN sales s ON s.ledger_record_id = r.id
     WHERE r.business_id = ? AND r.status = 'posted' AND r.occurred_at >= ? AND r.occurred_at < ?`,
    [scope.businessId, isoFromMs(fromMs), isoFromMs(toExclusiveMs)],
  );

  let salesRecordedMinor = 0;
  let salesReceivedMinor = 0;
  let expensesMinor = 0;
  let debtPaymentsReceivedMinor = 0;
  let debtCreatedMinor = 0;
  let saleCount = 0;
  let expenseCount = 0;

  for (const row of rows) {
    const amount = row.amount_minor ?? 0;
    if (row.record_type === 'sale') {
      salesRecordedMinor += amount;
      saleCount += 1;
      // A merchant assertion of payment is treated as received only when the
      // reviewer confirmed the sale as paid.
      if (row.payment_status === 'paid') salesReceivedMinor += amount;
    } else if (row.record_type === 'expense') {
      expensesMinor += amount;
      expenseCount += 1;
    } else if (row.record_type === 'debt_payment') {
      debtPaymentsReceivedMinor += amount;
    } else if (row.record_type === 'debt_created') {
      debtCreatedMinor += amount;
    }
  }

  const moneyInMinor = salesReceivedMinor + debtPaymentsReceivedMinor;
  return {
    salesRecordedMinor,
    salesReceivedMinor,
    expensesMinor,
    debtPaymentsReceivedMinor,
    debtCreatedMinor,
    moneyInMinor,
    moneyOutMinor: expensesMinor,
    netCashMovementMinor: moneyInMinor - expensesMinor,
    confirmedCount: rows.length,
    saleCount,
    expenseCount,
  };
}

export type CashBucket = { bucket: string; salesMinor: number; expensesMinor: number; count: number };

/**
 * Cash series for the chart. Bucketing happens in the business timezone, which
 * SQL cannot do portably, so the (bounded) period rows are grouped here.
 */
export async function cashSeries(
  db: Db,
  scope: TenantScope,
  fromMs: number,
  toExclusiveMs: number,
  bucketOf: (instantMs: number) => string,
  limit = 2000,
): Promise<CashBucket[]> {
  const rows = await all<{
    record_type: RecordType;
    amount_minor: number | null;
    occurred_at: string;
    payment_status: PaymentStatus | null;
  }>(
    db,
    `SELECT r.record_type, r.amount_minor, r.occurred_at, s.payment_status
     FROM ledger_records r
     LEFT JOIN sales s ON s.ledger_record_id = r.id
     WHERE r.business_id = ? AND r.status = 'posted'
       AND r.record_type IN ('sale', 'expense')
       AND r.occurred_at >= ? AND r.occurred_at < ?
     ORDER BY r.occurred_at ASC
     LIMIT ?`,
    [scope.businessId, isoFromMs(fromMs), isoFromMs(toExclusiveMs), limit],
  );
  const buckets = new Map<string, CashBucket>();
  for (const row of rows) {
    const instantMs = Date.parse(row.occurred_at);
    const key = bucketOf(instantMs);
    const bucket = buckets.get(key) ?? { bucket: key, salesMinor: 0, expensesMinor: 0, count: 0 };
    const amount = row.amount_minor ?? 0;
    if (row.record_type === 'sale') {
      if (row.payment_status === 'paid') bucket.salesMinor += amount;
    } else {
      bucket.expensesMinor += amount;
    }
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

export type CategoryTotal = { category: string; amountMinor: number; count: number };

export async function totalsByCategory(
  db: Db,
  scope: TenantScope,
  fromMs: number,
  toExclusiveMs: number,
  recordType: 'sale' | 'expense',
): Promise<CategoryTotal[]> {
  // Sales and expenses keep their category in different detail tables,
  // so each record type reads from its own.
  const detailTable = recordType === 'sale' ? 'sales' : 'expenses';
  const rows = await all<{ category: string | null; amount_minor: number | null }>(
    db,
    `SELECT t.category, r.amount_minor
     FROM ledger_records r
     JOIN ${detailTable} t ON t.ledger_record_id = r.id
     WHERE r.business_id = ? AND r.status = 'posted' AND r.record_type = ?
       AND r.occurred_at >= ? AND r.occurred_at < ?
     ORDER BY r.amount_minor DESC`,
    [scope.businessId, recordType, isoFromMs(fromMs), isoFromMs(toExclusiveMs)],
  );
  const totals = new Map<string, CategoryTotal>();
  for (const row of rows) {
    const category = row.category ?? 'uncategorised';
    const entry = totals.get(category) ?? { category, amountMinor: 0, count: 0 };
    entry.amountMinor += row.amount_minor ?? 0;
    entry.count += 1;
    totals.set(category, entry);
  }
  return [...totals.values()].sort((a, b) => b.amountMinor - a.amountMinor);
}

/** Review cue only: probable duplicates, never an automatic deletion. */
export async function findProbableDuplicates(
  db: Db,
  scope: TenantScope,
  input: { amountMinor: number | null; occurredAt: string | null; description: string | null },
): Promise<{ id: string; record_type: RecordType; occurred_at: string; amount_minor: number | null; description: string | null }[]> {
  if (input.amountMinor === null || input.occurredAt === null) return [];
  const occurredMs = Date.parse(input.occurredAt);
  const windowStart = new Date(occurredMs - 6 * 3_600_000).toISOString();
  const windowEnd = new Date(occurredMs + 6 * 3_600_000).toISOString();
  return await all(
    db,
    `SELECT id, record_type, occurred_at, amount_minor, description
     FROM ledger_records
     WHERE business_id = ? AND status = 'posted' AND amount_minor = ?
       AND occurred_at >= ? AND occurred_at <= ?
     LIMIT 5`,
    [scope.businessId, input.amountMinor, windowStart, windowEnd],
  );
}

export async function updateLedgerRecord(
  db: Db,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const allowed = new Set([
    'amount_minor',
    'occurred_at',
    'description',
    'customer_id',
    'payee_name',
    'status',
  ]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  await run(db, `UPDATE ledger_records SET ${assignments}, version = version + 1, updated_at = ? WHERE id = ?`, [
    ...entries.map(([, value]) => value),
    nowIso(),
    recordId,
  ]);
}

export async function updateLedgerVersion(
  db: Db,
  recordId: string,
  expectedVersion: number,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const allowed = new Set([
    'amount_minor',
    'occurred_at',
    'description',
    'customer_id',
    'payee_name',
    'status',
  ]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return false;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const changes = await run(
    db,
    `UPDATE ledger_records SET ${assignments}, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ?`,
    [...entries.map(([, value]) => value as string | number | null), nowIso(), recordId, expectedVersion],
  );
  return changes === 1;
}

export async function updateSaleDetail(
  db: Db,
  ledgerRecordId: string,
  values: { paymentStatus: PaymentStatus; paymentMethod: PaymentMethod; category?: string | null },
): Promise<void> {
  await run(
    db,
    'UPDATE sales SET payment_status = ?, payment_method = ?, category = COALESCE(?, category) WHERE ledger_record_id = ?',
    [values.paymentStatus, values.paymentMethod, values.category ?? null, ledgerRecordId],
  );
}

export async function updateExpenseDetail(db: Db, ledgerRecordId: string, category: string, vendor: string | null): Promise<void> {
  await run(db, 'UPDATE expenses SET category = ?, vendor = ? WHERE ledger_record_id = ?', [
    category,
    vendor,
    ledgerRecordId,
  ]);
}

export async function insertLedgerVersion(
  db: Db,
  input: {
    businessId: string;
    ledgerRecordId: string;
    version: number;
    snapshot: Record<string, unknown>;
    changeKind: 'created' | 'corrected' | 'reversed' | 'voided';
    actorUserId: string;
    reasonCode?: string | null;
    reasonNote?: string | null;
  },
): Promise<LedgerVersionRow> {
  const id = newId('lvr');
  await run(
    db,
    `INSERT INTO ledger_record_versions (
       id, business_id, ledger_record_id, version, snapshot_json, change_kind,
       reason_code, reason_note, actor_user_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.businessId,
      input.ledgerRecordId,
      input.version,
      toJson(input.snapshot),
      input.changeKind,
      input.reasonCode ?? null,
      input.reasonNote ?? null,
      input.actorUserId,
      nowIso(),
    ],
  );
  return await get<LedgerVersionRow>(db, 'SELECT * FROM ledger_record_versions WHERE id = ?', [id]) as LedgerVersionRow;
}

export async function listLedgerVersions(
  db: Db,
  scope: TenantScope,
  ledgerRecordId: string,
): Promise<(LedgerVersionRow & { actor_name: string })[]> {
  return await all<LedgerVersionRow & { actor_name: string }>(
    db,
    `SELECT v.*, u.display_name AS actor_name
     FROM ledger_record_versions v
     JOIN users u ON u.id = v.actor_user_id
     WHERE v.business_id = ? AND v.ledger_record_id = ?
     ORDER BY v.version ASC`,
    [scope.businessId, ledgerRecordId],
  );
}

export async function snapshotOf(db: Db, ledgerRecordId: string): Promise<Record<string, unknown>> {
  const record = await get<LedgerRecordRow>(db, 'SELECT * FROM ledger_records WHERE id = ?', [ledgerRecordId]);
  if (!record) return {};
  const detail = await readTypedDetail(db, record);
  return {
    recordType: record.record_type,
    occurredAt: record.occurred_at,
    currency: record.currency,
    amountMinor: record.amount_minor,
    description: record.description,
    customerId: record.customer_id,
    status: record.status,
    version: record.version,
    paymentStatus: detail.paymentStatus ?? null,
    paymentMethod: detail.paymentMethod ?? null,
    category: detail.category ?? null,
    payee: record.payee_name,
  };
}

export async function listRecentLedgerRecords(
  db: Db,
  scope: TenantScope,
  limit: number,
): Promise<LedgerRecordWithDetail[]> {
  return await listLedgerRecords(db, scope, {
    fromMs: 0,
    toExclusiveMs: Date.now() + 365 * 86_400_000,
    statuses: ['posted'],
    limit,
  });
}

export async function countConfirmedRecords(db: Db, scope: TenantScope): Promise<number> {
  const row = await get<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM ledger_records WHERE business_id = ? AND status = 'posted'`,
    [scope.businessId],
  );
  return row?.count ?? 0;
}