/**
 * Corrections and reversals.
 *
 * Financial history is never destructively edited. A correction restates a
 * posted record in place and bumps its version, keeping the previous snapshot
 * in `ledger_record_versions`; a reversal marks the record reversed so it stops
 * feeding every derived total. Both require a reason, an expected version and a
 * permission check, and both land in one transaction with their audit events.
 *
 * Every derived figure in this codebase reads `ledger_records.status = 'posted'`,
 * which is what makes a reversal correct: the reversed record and the payments or
 * stock movements it produced drop out of deni balances, inventory balances and
 * cash totals together, with no compensating entries that would double count.
 */

import { withTransaction, type Db } from '@/server/db/client';
import { nowIso } from '@/server/db/ids';
import { ERROR_CODES, conflict, notFound, validationFailed } from '@/lib/errors';
import type { BusinessContext } from '@/server/business-context/context';
import type { Currency } from '@/lib/formatting/money';
import { emptyProposalFields, type ProposalFields } from '@/lib/validation/proposal';
import {
  applyFieldOverrides,
  confirmationIssues,
  unpaidMinor,
} from '@/server/services/confirmation';
import {
  findLedgerRecordById,
  hydrateLedgerRecord,
  insertLedgerVersion,
  listLedgerVersions,
  snapshotOf,
  updateExpenseDetail,
  updateLedgerVersion,
  updateSaleDetail,
  type LedgerDetail,
  type LedgerRecordRow,
} from '@/server/repositories/ledger.repository';
import {
  createCustomer,
  findCustomerById,
  findCustomerByName,
  findLiveObligationForRecord,
  insertObligation,
  listObligationsForCustomer,
  restateObligation,
  setObligationState,
} from '@/server/repositories/debt.repository';
import { enqueueOutboxEvent } from '@/server/repositories/platform.repository';
import { recordAuditSafely } from '@/server/services/audit';
import type { RecordType } from '@/server/domain/types';
import { logger } from '@/server/observability/logger';

export type CorrectionAction = 'correct' | 'reverse';

export type CorrectionInput = {
  recordId: string;
  expectedVersion: number;
  action: CorrectionAction;
  reasonCode: string;
  reasonNote?: string | null;
  /** Corrected field values. Only meaningful for `action: 'correct'`. */
  fields?: Partial<ProposalFields>;
  actorUserId: string;
  requestId?: string | null;
};

export type CorrectionResult = {
  action: CorrectionAction;
  record: LedgerRecordRow;
  issues?: { field: string; code: string; message: string }[];
};

/**
 * Fields a correction may restate.
 *
 * Stock quantity is deliberately absent: a movement's quantity lives in
 * `inventory_movements` and is evidence in its own right, so restating it would
 * rewrite that history. A quantity change goes through reverse-and-re-enter.
 */
const CORRECTABLE_FIELDS = [
  'amountMinor',
  'occurredAt',
  'description',
  'category',
  'payee',
  'customerId',
  'customerName',
  'paymentStatus',
  'paymentMethod',
  'amountPaidMinor',
  'dueDate',
  'note',
] as const satisfies readonly (keyof ProposalFields)[];

const REVERSIBLE_TYPES: readonly RecordType[] = [
  'sale',
  'expense',
  'debt_created',
  'debt_payment',
  'stock_movement',
];

/** Rebuilds the editable field set from what was actually posted. */
export function fieldsFromRecord(
  record: LedgerRecordRow,
  detail: LedgerDetail,
  customerName: string | null,
  currency: Currency,
): ProposalFields {
  const fields = emptyProposalFields(currency);
  return {
    ...fields,
    amountMinor: record.amount_minor,
    occurredAt: record.occurred_at,
    occurredAtBasis: 'explicit',
    description: record.description,
    category: detail.category ?? null,
    payee: record.payee_name ?? detail.payee ?? null,
    customerId: record.customer_id,
    customerName,
    paymentStatus: detail.paymentStatus ?? null,
    paymentMethod: detail.paymentMethod ?? null,
    quantityMilli: detail.quantityMilli ?? null,
    unit: detail.unit ?? null,
    movementType: detail.movementType ?? null,
    itemId: detail.itemId ?? null,
    note: detail.note ?? null,
  };
}

function assertAdjustable(action: CorrectionAction, record: LedgerRecordRow): void {
  if (record.status !== 'posted') {
    throw conflict(
      ERROR_CODES.RECORD_NOT_POSTED,
      `This record is already ${record.status}, so it cannot be ${
        action === 'correct' ? 'corrected' : 'reversed'
      } again`,
      { status: record.status },
    );
  }
  if (action === 'reverse' && !REVERSIBLE_TYPES.includes(record.record_type)) {
    throw validationFailed('Only financial records can be reversed', {
      recordType: record.record_type,
    });
  }
}

function assertCorrectableFields(fields: Partial<ProposalFields>): void {
  const unsupported = Object.keys(fields).filter(
    (key) => !(CORRECTABLE_FIELDS as readonly string[]).includes(key),
  );
  if (unsupported.length > 0) {
    throw validationFailed('Some fields cannot be corrected on a posted record', {
      unsupported,
      supported: [...CORRECTABLE_FIELDS],
    });
  }
}

/**
 * Keeps the obligation behind a record consistent with a corrected amount.
 *
 * What a customer owes is stored on the obligation, so a correction that changes
 * the amount has to restate it. An obligation that money has already been applied
 * to cannot be reduced below what was paid, so that is refused rather than
 * quietly producing a negative balance.
 */
async function restateDeniAfterCorrection(
  db: Db,
  context: BusinessContext,
  record: LedgerRecordRow,
  fields: ProposalFields,
  actorUserId: string,
  customerId: string | null,
): Promise<void> {
  const scope = { businessId: context.businessId };
  if (record.record_type !== 'sale' && record.record_type !== 'debt_created') return;

  const remaining = record.record_type === 'sale' ? unpaidMinor(fields) : (fields.amountMinor ?? 0);
  const obligation = await findLiveObligationForRecord(db, scope, record.id);

  if (!obligation) {
    if (remaining <= 0) return;
    if (!customerId) {
      throw validationFailed('This record leaves money owed, so it needs a customer');
    }
    await insertObligation(db, {
      businessId: context.businessId,
      ledgerRecordId: record.id,
      customerId,
      originalAmountMinor: remaining,
      dueDate: fields.dueDate,
    });
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'obligation.created',
      entityType: 'ledger_record',
      entityId: record.id,
      actorUserId,
      reasonCode: 'record_corrected',
      after: { originalAmountMinor: remaining, from: 'correction' },
    });
    return;
  }

  if (remaining < obligation.paid_minor) {
    throw conflict(
      ERROR_CODES.OBLIGATION_HAS_PAYMENTS,
      'Payments are already applied to this debt, so the amount cannot be reduced that far. Reverse the record instead.',
      { paidMinor: obligation.paid_minor, correctedAmountMinor: remaining },
    );
  }

  await restateObligation(db, obligation.id, {
    originalAmountMinor: remaining,
    dueDate: fields.dueDate ?? obligation.due_date,
    state: remaining === 0 ? 'settled' : 'open',
  });
  await recordAuditSafely(db, {
    businessId: context.businessId,
    action: 'obligation.restated',
    entityType: 'ledger_record',
    entityId: record.id,
    actorUserId,
    reasonCode: 'record_corrected',
    before: {
      originalAmountMinor: obligation.original_amount_minor,
      dueDate: obligation.due_date,
    },
    after: { originalAmountMinor: remaining, dueDate: fields.dueDate ?? obligation.due_date },
  });
}

/**
 * Resolves the customer a corrected record belongs to.
 *
 * A correction may name a customer by id, or by name for an account that does not
 * exist yet, matching confirmation: a correction that turns a paid sale into an
 * unpaid one has to be able to say who now owes the money.
 */
async function correctedCustomerId(
  db: Db,
  context: BusinessContext,
  record: LedgerRecordRow,
  fields: ProposalFields,
  actorUserId: string,
): Promise<string | null> {
  const requestedId = fields.customerId ?? null;
  if (requestedId) {
    if (requestedId === record.customer_id) return record.customer_id;
    const customer = await findCustomerById(db, { businessId: context.businessId }, requestedId);
    if (!customer) throw notFound('Customer not found');
    return customer.id;
  }

  const name = fields.customerName?.trim();
  if (!name) return record.customer_id;
  const existing = await findCustomerByName(db, { businessId: context.businessId }, name);
  if (existing) return existing.id;
  const created = await createCustomer(db, { businessId: context.businessId }, name);
  await recordAuditSafely(db, {
    businessId: context.businessId,
    action: 'customer.created',
    entityType: 'customer',
    entityId: created.id,
    actorUserId,
    reasonCode: 'record_corrected',
    after: { displayName: created.display_name, from: 'correction' },
  });
  return created.id;
}

/**
 * Applies a correction or a reversal to a posted record.
 *
 * The client's `expectedVersion` is compared against the stored version inside
 * the transaction, so two reviewers correcting the same record cannot silently
 * overwrite one another: the second one loses and is told to reload.
 */
export async function applyCorrection(
  db: Db,
  context: BusinessContext,
  input: CorrectionInput,
): Promise<CorrectionResult> {
  const scope = { businessId: context.businessId };
  const record = await findLedgerRecordById(db, scope, input.recordId);
  if (!record) throw notFound('Record not found');

  assertAdjustable(input.action, record);

  if (input.action === 'reverse') {
    return withTransaction(async () => await reverseRecord(db, context, record, input), db);
  }

  const overrides = input.fields ?? {};
  assertCorrectableFields(overrides);
  if (Object.keys(overrides).length === 0) {
    throw validationFailed('A correction needs at least one changed field');
  }

  const hydrated = await hydrateLedgerRecord(db, record);
  const fields = applyFieldOverrides(
    fieldsFromRecord(record, hydrated.detail, hydrated.customerName, context.currency),
    overrides,
  );

  const issues = confirmationIssues(record.record_type, fields);
  if (issues.length > 0) {
    return {
      action: 'correct',
      record,
      issues: issues.map((issue) => ({
        field: issue.field,
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  return withTransaction(async () => await correctRecord(db, context, record, fields, input), db);
}

async function correctRecord(
  db: Db,
  context: BusinessContext,
  record: LedgerRecordRow,
  fields: ProposalFields,
  input: CorrectionInput,
): Promise<CorrectionResult> {
  const scope = { businessId: context.businessId };
  const before = await snapshotOf(db, record.id);

  // The customer is resolved first: a correction may attach one, and the deni
  // restatement below needs the account the record now belongs to.
  const customerId = await correctedCustomerId(db, context, record, fields, input.actorUserId);

  const updated = await updateLedgerVersion(db, record.id, input.expectedVersion, {
    amount_minor: record.record_type === 'stock_movement' ? null : fields.amountMinor,
    occurred_at: fields.occurredAt ?? record.occurred_at,
    description: fields.description ?? fields.itemsText,
    customer_id: customerId,
    payee_name: fields.payee,
  });
  if (!updated) {
    throw conflict(
      ERROR_CODES.RECORD_VERSION_CONFLICT,
      'This record changed since you opened it. Reload and review it again.',
      { expectedVersion: input.expectedVersion },
    );
  }

  if (record.record_type === 'sale' && fields.paymentStatus) {
    await updateSaleDetail(db, record.id, {
      paymentStatus: fields.paymentStatus,
      paymentMethod: fields.paymentMethod ?? 'cash',
      category: fields.category,
    });
  }
  if (record.record_type === 'expense' && fields.category) {
    await updateExpenseDetail(db, record.id, fields.category, fields.payee);
  }

  await restateDeniAfterCorrection(db, context, record, fields, input.actorUserId, customerId);

  const current = await findLedgerRecordById(db, scope, record.id) as LedgerRecordRow;
  await insertLedgerVersion(db, {
    businessId: context.businessId,
    ledgerRecordId: record.id,
    version: current.version,
    snapshot: before,
    changeKind: 'corrected',
    actorUserId: input.actorUserId,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote,
  });
  await recordAuditSafely(db, {
    businessId: context.businessId,
    action: 'ledger_record.corrected',
    entityType: 'ledger_record',
    entityId: record.id,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote,
    before,
    after: await snapshotOf(db, record.id),
  });
  await enqueueOutboxEvent(db, {
    businessId: context.businessId,
    topic: 'ledger.record_corrected',
    entityType: 'ledger_record',
    entityId: record.id,
    payload: { recordId: record.id, version: current.version },
  });

  logger.info('correction.record_corrected', {
    businessId: context.businessId,
    ledgerRecordId: record.id,
    version: current.version,
  });
  return { action: 'correct', record: current };
}

/**
 * Re-derives obligation states after a payment is reversed.
 *
 * A payment can leave an obligation marked settled. Once the payment record is
 * reversed its applied amount stops counting, so the state has to be recomputed
 * or the customer would appear settled while still owing money.
 */
async function restateCustomerObligationStates(db: Db, context: BusinessContext, customerId: string): Promise<void> {
  for (const obligation of await listObligationsForCustomer(db, { businessId: context.businessId }, customerId)) {
    const settled = obligation.paid_minor >= obligation.original_amount_minor;
    if ((obligation.state === 'settled') !== settled) {
      await setObligationState(db, obligation.id, settled ? 'settled' : 'open');
    }
  }
}

async function reverseRecord(
  db: Db,
  context: BusinessContext,
  record: LedgerRecordRow,
  input: CorrectionInput,
): Promise<CorrectionResult> {
  const scope = { businessId: context.businessId };
  const before = await snapshotOf(db, record.id);

  const updated = await updateLedgerVersion(db, record.id, input.expectedVersion, { status: 'reversed' });
  if (!updated) {
    throw conflict(
      ERROR_CODES.RECORD_VERSION_CONFLICT,
      'This record changed since you opened it. Reload and review it again.',
      { expectedVersion: input.expectedVersion },
    );
  }

  // The obligation is voided rather than deleted: the row is part of the
  // customer's history, and the posted-record join already excludes everything
  // attached to a reversed record.
  const obligation = await findLiveObligationForRecord(db, scope, record.id);
  if (obligation) await setObligationState(db, obligation.id, 'voided');
  if (record.record_type === 'debt_payment' && record.customer_id) {
    await restateCustomerObligationStates(db, context, record.customer_id);
  }

  const current = await findLedgerRecordById(db, scope, record.id) as LedgerRecordRow;
  await insertLedgerVersion(db, {
    businessId: context.businessId,
    ledgerRecordId: record.id,
    version: current.version,
    snapshot: before,
    changeKind: 'reversed',
    actorUserId: input.actorUserId,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote,
  });
  await recordAuditSafely(db, {
    businessId: context.businessId,
    action: 'ledger_record.reversed',
    entityType: 'ledger_record',
    entityId: record.id,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote,
    before,
    after: await snapshotOf(db, record.id),
  });
  await enqueueOutboxEvent(db, {
    businessId: context.businessId,
    topic: 'ledger.record_reversed',
    entityType: 'ledger_record',
    entityId: record.id,
    payload: { recordId: record.id, version: current.version },
  });

  logger.info('correction.record_reversed', {
    businessId: context.businessId,
    ledgerRecordId: record.id,
    version: current.version,
    reversedAt: nowIso(),
  });
  return { action: 'reverse', record: current };
}

export type RecordHistoryEntry = {
  version: number;
  changeKind: 'created' | 'corrected' | 'reversed' | 'voided';
  actorName: string;
  reasonCode: string | null;
  reasonNote: string | null;
  snapshot: Record<string, unknown>;
  createdAt: string;
};

/** The version history a reviewer needs in order to defend a decision. */
export async function recordHistory(
  db: Db,
  context: BusinessContext,
  recordId: string,
): Promise<RecordHistoryEntry[]> {
  return (await listLedgerVersions(db, { businessId: context.businessId }, recordId)).map((row) => ({
    version: row.version,
    changeKind: row.change_kind,
    actorName: row.actor_name,
    reasonCode: row.reason_code,
    reasonNote: row.reason_note,
    snapshot: JSON.parse(row.snapshot_json) as Record<string, unknown>,
    createdAt: row.created_at,
  }));
}
