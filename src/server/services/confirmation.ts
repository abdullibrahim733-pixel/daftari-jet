/**
 * Confirmation service: the only path from a proposal to the ledger.
 *
 * Invariants enforced here:
 *  - a human decision is required (the caller supplies a confirmed-by user id);
 *  - the ledger record, its typed detail, any debt effect, the inventory effect,
 *    the proposal state change and the audit events all commit in one
 *    transaction, so a partially applied confirmation is impossible;
 *  - an optimistic version check prevents a stale reviewer's decision from
 *    overwriting a newer edit;
 *  - confirming the same proposal twice is a no-op that returns the record that
 *    already exists.
 */

import { withTransaction, type Db } from '@/server/db/client';
import { nowIso } from '@/server/db/ids';
import {
  partialSaleSchema,
  typedRecordSchema,
  type ProposalFields,
  type ValidationIssue,
} from '@/lib/validation/proposal';
import type { LedgerRecordStatus, PaymentStatus, RecordType } from '@/server/domain/types';
import type { BusinessContext } from '@/server/business-context/context';
import { conflict, notFound, validationFailed, ERROR_CODES } from '@/lib/errors';
import {
  findProposalById,
  markProposalConfirmed,
  proposalFields,
  setProposalState,
  type ProposalRow,
} from '@/server/repositories/source.repository';
import {
  insertLedgerRecord,
  updateExpenseDetail,
  updateSaleDetail,
  type LedgerDetail,
  type LedgerRecordRow,
} from '@/server/repositories/ledger.repository';
import {
  createCustomer,
  findCustomerById,
  findCustomerByName,
  insertDebtPayment,
  insertObligation,
  listObligationsForCustomer,
  setObligationState,
  type CustomerRow,
} from '@/server/repositories/debt.repository';
import { findItemById, findItemByName, insertMovement } from '@/server/repositories/inventory.repository';
import { enqueueOutboxEvent } from '@/server/repositories/platform.repository';
import { recordAuditSafely } from './audit';
import { typedRecordForValidation } from './pipeline';
import { logger } from '@/server/observability/logger';

export type ConfirmInput = {
  proposalId: string;
  expectedVersion: number;
  confirmedByUserId: string;
  requestId?: string | null;
  reasonCode?: string | null;
  /** Reviewer overrides applied in the same transaction as the confirmation. */
  fields?: Partial<ProposalFields>;
  note?: string | null;
};

export type ConfirmResult =
  | { kind: 'confirmed'; record: LedgerRecordRow; customer: CustomerRow | null }
  | { kind: 'already_confirmed'; recordId: string }
  | { kind: 'invalid'; issues: ValidationIssue[] };

export function applyFieldOverrides(
  fields: ProposalFields,
  overrides: Partial<ProposalFields>,
): ProposalFields {
  const next: ProposalFields = { ...fields };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (Object.hasOwn(next, key)) {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

async function resolveCustomer(
  db: Db,
  context: BusinessContext,
  fields: ProposalFields,
  confirmedByUserId: string,
): Promise<CustomerRow> {
  if (fields.customerId) {
    const existing = await findCustomerById(db, { businessId: context.businessId }, fields.customerId);
    if (!existing) throw notFound('Customer not found');
    return existing;
  }
  const name = fields.customerName?.trim();
  if (!name) throw validationFailed('A customer is required for this record type');
  const existing = await findCustomerByName(db, { businessId: context.businessId }, name);
  if (existing) return existing;
  const created = await createCustomer(db, { businessId: context.businessId }, name);
  await recordAuditSafely(db, {
    businessId: context.businessId,
    action: 'customer.created',
    entityType: 'customer',
    entityId: created.id,
    actorUserId: confirmedByUserId,
    after: { displayName: created.display_name, source: 'confirmation' },
  });
  return created;
}

/** What a sale still leaves owed, given its total and what was already paid. */
export function unpaidMinor(fields: ProposalFields): number {
  if (fields.paymentStatus === 'paid') return 0;
  if (fields.paymentStatus === 'partial') {
    const total = fields.amountMinor ?? 0;
    const paid = fields.amountPaidMinor ?? 0;
    return Math.max(0, total - paid);
  }
  return fields.amountMinor ?? 0;
}

/** Applies the debt side effects of a confirmed record. */
async function applyDebtEffects(
  db: Db,
  context: BusinessContext,
  record: LedgerRecordRow,
  recordType: RecordType,
  fields: ProposalFields,
  customer: CustomerRow,
  confirmedByUserId: string,
): Promise<void> {
  const scope = { businessId: context.businessId };

  if (recordType === 'sale') {
    const remaining = unpaidMinor(fields);
    if (remaining > 0) {
      await insertObligation(db, {
        businessId: context.businessId,
        ledgerRecordId: record.id,
        customerId: customer.id,
        originalAmountMinor: remaining,
        dueDate: fields.dueDate,
      });
      await recordAuditSafely(db, {
        businessId: context.businessId,
        action: 'obligation.created',
        entityType: 'ledger_record',
        entityId: record.id,
        actorUserId: confirmedByUserId,
        after: { customerId: customer.id, originalAmountMinor: remaining, from: 'sale' },
      });
    }
    return;
  }

  if (recordType === 'debt_created') {
    await insertObligation(db, {
      businessId: context.businessId,
      ledgerRecordId: record.id,
      customerId: customer.id,
      originalAmountMinor: fields.amountMinor ?? 0,
      dueDate: fields.dueDate,
    });
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'obligation.created',
      entityType: 'ledger_record',
      entityId: record.id,
      actorUserId: confirmedByUserId,
      after: { customerId: customer.id, originalAmountMinor: fields.amountMinor ?? 0 },
    });
    return;
  }

  if (recordType === 'debt_payment') {
    const amount = fields.amountMinor ?? 0;
    // Apply to the oldest open obligation first so the ledger of what is owed
    // stays predictable; payments without a matching obligation stay unapplied
    // and visible as customer credit.
    const obligations = (await listObligationsForCustomer(db, scope, customer.id))
      .filter((obligation) => obligation.state === 'open')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    let remaining = amount;
    let appliedTo: string | null = null;
    for (const obligation of obligations) {
      if (remaining <= 0) break;
      const outstanding = obligation.original_amount_minor - obligation.paid_minor;
      if (outstanding <= 0) continue;
      const applied = Math.min(outstanding, remaining);
      await insertDebtPayment(db, {
        businessId: context.businessId,
        ledgerRecordId: record.id,
        obligationId: obligation.id,
        customerId: customer.id,
        amountMinor: applied,
        method: fields.paymentMethod ?? 'cash',
        reference: null,
        receivedAt: record.occurred_at,
      });
      appliedTo = obligation.id;
      remaining -= applied;
      const paidTotal = obligation.paid_minor + applied;
      await setObligationState(
        db,
        obligation.id,
        paidTotal >= obligation.original_amount_minor ? 'settled' : 'open',
      );
    }
    if (remaining > 0) {
      await insertDebtPayment(db, {
        businessId: context.businessId,
        ledgerRecordId: record.id,
        obligationId: null,
        customerId: customer.id,
        amountMinor: remaining,
        method: fields.paymentMethod ?? 'cash',
        reference: null,
        receivedAt: record.occurred_at,
      });
    }
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'debt_payment.recorded',
      entityType: 'ledger_record',
      entityId: record.id,
      actorUserId: confirmedByUserId,
      after: { customerId: customer.id, amountMinor: amount, appliedToObligationId: appliedTo },
    });
  }
}

async function applyInventoryEffects(
  db: Db,
  context: BusinessContext,
  record: LedgerRecordRow,
  fields: ProposalFields,
  confirmedByUserId: string,
): Promise<void> {
  if (!context.features.inventory) return;
  const scope = { businessId: context.businessId };
  const item = fields.itemId
    ? await findItemById(db, scope, fields.itemId)
    : fields.itemName
      ? await findItemByName(db, scope, fields.itemName)
      : undefined;
  if (!item) {
    throw validationFailed('Select the stock item for this movement');
  }
  if (!fields.quantityMilli || fields.quantityMilli <= 0) {
    throw validationFailed('Enter the quantity for this movement');
  }
  await insertMovement(db, {
    businessId: context.businessId,
    itemId: item.id,
    ledgerRecordId: record.id,
    movementType: fields.movementType ?? 'out',
    quantityMilli: fields.quantityMilli,
    unitCostMinor: fields.unitCostMinor,
    note: fields.note,
    occurredAt: record.occurred_at,
  });
  await recordAuditSafely(db, {
    businessId: context.businessId,
    action: 'inventory_movement.recorded',
    entityType: 'inventory_item',
    entityId: item.id,
    actorUserId: confirmedByUserId,
    after: { ledgerRecordId: record.id, quantityMilli: fields.quantityMilli, movementType: fields.movementType },
  });
}

function detailFor(recordType: RecordType, fields: ProposalFields, note: string | null): LedgerDetail {
  switch (recordType) {
    case 'sale':
      return {
        paymentStatus: fields.paymentStatus as PaymentStatus,
        paymentMethod: fields.paymentMethod ?? 'cash',
        category: fields.category ?? undefined,
        items: fields.itemsText
          ? [
              {
                description: fields.itemsText,
                quantityMilli: 1_000,
                unit: 'unit',
                lineAmountMinor: fields.amountMinor,
              },
            ]
          : [],
      };
    case 'expense':
      return {
        items: [],
        category: fields.category ?? 'other',
        vendor: fields.payee,
        payee: fields.payee,
        paymentStatus: fields.paymentStatus ?? undefined,
        paymentMethod: fields.paymentMethod ?? undefined,
      };
    case 'stock_movement':
      return {
        items: [],
        itemId: fields.itemId,
        quantityMilli: fields.quantityMilli,
        unit: fields.unit,
        movementType: fields.movementType ?? 'out',
        unitCostMinor: fields.unitCostMinor,
        note,
      };
    case 'note':
      return { items: [], note };
    default:
      return { items: [], note };
  }
}

export async function confirmProposal(
  db: Db,
  context: BusinessContext,
  input: ConfirmInput,
): Promise<ConfirmResult> {
  const scope = { businessId: context.businessId };
  const proposal = await findProposalById(db, scope, input.proposalId);
  if (!proposal) throw notFound('Proposal not found');

  if (proposal.state === 'confirmed' && proposal.confirmed_ledger_record_id) {
    return { kind: 'already_confirmed', recordId: proposal.confirmed_ledger_record_id };
  }
  if (proposal.state === 'rejected') {
    throw conflict(
      ERROR_CODES.PROPOSAL_NOT_REVIEWABLE,
      'This proposal was rejected and cannot be confirmed',
    );
  }
  if (proposal.version !== input.expectedVersion) {
    throw conflict(
      ERROR_CODES.PROPOSAL_VERSION_CONFLICT,
      'This proposal changed since you opened it. Reload and review again.',
      { expectedVersion: input.expectedVersion, currentVersion: proposal.version },
    );
  }

  const recordType = proposal.record_type as RecordType;
  const currentFields = proposalFields(proposal);
  const fields = applyFieldOverrides(currentFields, input.fields ?? {});

  const issues = confirmationIssues(recordType, fields);

  if (issues.length > 0) {
    return { kind: 'invalid', issues };
  }

  // A customer is only required when there is a balance to collect: debt
  // records name someone by definition, and a sale that leaves money owed
  // needs an account to owe it to. A fully paid walk-in sale has nobody to
  // chase, so it stays customer-less.
  const needsCustomer =
    recordType === 'debt_created' ||
    recordType === 'debt_payment' ||
    (recordType === 'sale' && unpaidMinor(fields) > 0);
  const needsInventory = recordType === 'stock_movement' && context.features.inventory;

  return withTransaction(async () => {
    const customer = needsCustomer ? await resolveCustomer(db, context, fields, input.confirmedByUserId) : null;

    const record = await insertLedgerRecord(db, {
      businessId: context.businessId,
      recordType,
      occurredAt: fields.occurredAt ?? nowIso(),
      currency: context.currency,
      amountMinor: recordType === 'stock_movement' ? null : fields.amountMinor,
      description: fields.description ?? fields.itemsText ?? input.note ?? null,
      customerId: customer?.id ?? null,
      payeeName: fields.payee ?? null,
      origin: proposal.source_event_id ? 'whatsapp' : 'manual',
      sourceEventId: proposal.source_event_id,
      proposalId: proposal.id,
      createdByUserId: input.confirmedByUserId,
      detail: detailFor(recordType, fields, input.note ?? fields.note ?? null),
    });

    if (recordType === 'sale') {
      await updateSaleDetail(db, record.id, {
        paymentStatus: fields.paymentStatus as PaymentStatus,
        paymentMethod: fields.paymentMethod ?? 'cash',
        category: fields.category ?? null,
      });
    }
    if (recordType === 'expense' && fields.category) {
      await updateExpenseDetail(db, record.id, fields.category, fields.payee ?? null);
    }

    if (customer) {
      await applyDebtEffects(db, context, record, recordType, fields, customer, input.confirmedByUserId);
    }
    if (needsInventory) {
      await applyInventoryEffects(db, context, record, fields, input.confirmedByUserId);
    }

    const confirmed = markProposalConfirmed(
      db,
      proposal.id,
      record.id,
      input.confirmedByUserId,
      input.expectedVersion,
    );
    if (!confirmed) {
      // Another reviewer confirmed or edited this proposal first.
      throw conflict(ERROR_CODES.PROPOSAL_NOT_REVIEWABLE, 'This proposal was already decided by someone else');
    }

    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'ledger_record.created',
      entityType: 'ledger_record',
      entityId: record.id,
      actorUserId: input.confirmedByUserId,
      requestId: input.requestId ?? null,
      reasonCode: input.reasonCode ?? 'proposal_confirmed',
      after: {
        recordType,
        amountMinor: record.amount_minor,
        occurredAt: record.occurred_at,
        proposalId: proposal.id,
        sourceEventId: proposal.source_event_id,
      },
    });
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'proposal.confirmed',
      entityType: 'proposal',
      entityId: proposal.id,
      actorUserId: input.confirmedByUserId,
      requestId: input.requestId ?? null,
      after: { ledgerRecordId: record.id },
    });
    await enqueueOutboxEvent(db, {
      businessId: context.businessId,
      topic: 'ledger.record_confirmed',
      entityType: 'ledger_record',
      entityId: record.id,
      payload: { recordType, proposalId: proposal.id },
    });

    logger.info('confirmation.record_created', {
      businessId: context.businessId,
      proposalId: proposal.id,
      ledgerRecordId: record.id,
      recordType,
      status: record.status as LedgerRecordStatus,
    });

    return { kind: 'confirmed', record, customer };
  }, db);
}

/**
 * Validates the fields a confirmation would post.
 *
 * Shared with corrections so a corrected record is held to exactly the same
 * rules as the original confirmation.
 */
export function confirmationIssues(recordType: RecordType, fields: ProposalFields): ValidationIssue[] {
  const payload = typedRecordForValidation(recordType, fields);
  const result =
    recordType === 'sale' ? partialSaleSchema.safeParse(payload) : typedRecordSchema.safeParse(payload);
  if (result.success) return [];
  return result.error.issues.slice(0, 12).map((issue) => ({
    field: issue.path.join('.') || 'record',
    code: issue.code,
    message: issue.message,
    severity: 'error' as const,
  }));
}

export type RejectInput = {
  proposalId: string;
  expectedVersion: number;
  rejectedByUserId: string;
  reasonCode: string;
  reasonNote?: string | null;
};

/** Rejects a proposal. No ledger effect, and the reason is always recorded. */
export async function rejectProposal(db: Db, context: BusinessContext, input: RejectInput): Promise<ProposalRow> {
  const proposal = await findProposalById(db, { businessId: context.businessId }, input.proposalId);
  if (!proposal) throw notFound('Proposal not found');
  if (proposal.state === 'confirmed') throw conflict(ERROR_CODES.PROPOSAL_NOT_REVIEWABLE, 'A confirmed record cannot be rejected');
  if (proposal.version !== input.expectedVersion) {
    throw conflict(
      ERROR_CODES.PROPOSAL_VERSION_CONFLICT,
      'This proposal changed since you opened it. Reload and review again.',
    );
  }
  return withTransaction(async () => {
    await setProposalState(
      db,
      proposal.id,
      'rejected',
      {
        decidedByUserId: input.rejectedByUserId,
        decidedAt: nowIso(),
        rejectionReasonCode: input.reasonCode,
        rejectionNote: input.reasonNote ?? null,
      },
    );
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'proposal.rejected',
      entityType: 'proposal',
      entityId: proposal.id,
      actorUserId: input.rejectedByUserId,
      reasonCode: input.reasonCode,
      reasonNote: input.reasonNote ?? null,
      before: { state: proposal.state },
      after: { state: 'rejected' },
    });
    return await findProposalById(db, { businessId: context.businessId }, proposal.id) as ProposalRow;
  }, db);
}
