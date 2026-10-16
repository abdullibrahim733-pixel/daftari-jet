/**
 * Manual ledger entry.
 *
 * A merchant typing a record is already the human confirmation, so the entry
 * becomes a proposal with no source event and is confirmed immediately through
 * the same validation, deni and inventory path as a reviewed voice message.
 * One code path means a manual record cannot bypass a rule.
 */

import { withTransaction, type Db } from '@/server/db/client';
import { insertProposal } from '@/server/repositories/source.repository';
import { confirmProposal, type ConfirmResult } from '@/server/services/confirmation';
import { recordAuditSafely } from '@/server/services/audit';
import { missingRequiredFields, emptyProposalFields, type ProposalFields } from '@/lib/validation/proposal';
import { validationFailed } from '@/lib/errors';
import type { BusinessContext } from '@/server/business-context/context';
import type { RecordType } from '@/server/domain/types';

export type ManualEntryInput = {
  recordType: RecordType;
  occurredAt: string;
  fields: Partial<ProposalFields>;
  note?: string | null;
};

export type ManualEntryResult = {
  proposalId: string;
  confirmation: Extract<ConfirmResult, { kind: 'confirmed' }>;
};

/** Turns the API payload into reviewable fields for the given record type. */
function fieldsForInput(context: BusinessContext, input: ManualEntryInput): ProposalFields {
  return {
    ...emptyProposalFields(context.currency),
    occurredAt: input.occurredAt,
    occurredAtBasis: 'explicit',
    amountMinor: input.fields.amountMinor ?? null,
    amountPaidMinor: input.fields.amountPaidMinor ?? null,
    description: input.fields.description ?? null,
    customerId: input.fields.customerId ?? null,
    customerName: input.fields.customerName ?? null,
    paymentStatus: input.fields.paymentStatus ?? null,
    paymentMethod: input.fields.paymentMethod ?? null,
    category: input.fields.category ?? null,
    payee: input.fields.payee ?? null,
    dueDate: input.fields.dueDate ?? null,
    itemsText: input.fields.itemsText ?? null,
    itemId: input.fields.itemId ?? null,
    itemName: input.fields.itemName ?? null,
    quantityMilli: input.fields.quantityMilli ?? null,
    unit: input.fields.unit ?? null,
    movementType: input.fields.movementType ?? null,
    note: input.fields.note ?? input.note ?? null,
  };
}

export async function recordManualEntry(
  db: Db,
  context: BusinessContext,
  input: ManualEntryInput,
): Promise<ManualEntryResult> {
  if (!context.features.manualEntries) {
    throw validationFailed('Manual entry is not enabled for this business');
  }

  const fields = fieldsForInput(context, input);
  const missing = missingRequiredFields(input.recordType, fields);

  const proposal = await withTransaction(async () => {
    const created = await insertProposal(db, {
      businessId: context.businessId,
      // No source event: this record came from a human, not from a message.
      sourceEventId: null,
      transcriptId: null,
      recordType: input.recordType,
      state: 'needs_review',
      schemaVersion: '1',
      provider: 'manual',
      modelVersion: `user:${context.userId}`,
      fields,
      provenance: {},
      missingFields: missing,
      validationIssues: [],
      duplicateCandidates: [],
    });
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'proposal.created',
      entityType: 'proposal',
      entityId: created.id,
      actorUserId: context.userId,
      source: 'dashboard',
      after: { recordType: input.recordType, missingFields: missing },
    });
    return created;
  }, db);

  const confirmation = await confirmProposal(db, context, {
    proposalId: proposal.id,
    expectedVersion: proposal.version,
    confirmedByUserId: context.userId,
    fields: undefined,
    note: input.note ?? null,
    requestId: null,
  });

  if (confirmation.kind !== 'confirmed') {
    throw validationFailed('This entry still needs attention before it can be recorded', {
      state: confirmation.kind,
      recordId: confirmation.kind === 'already_confirmed' ? confirmation.recordId : null,
    });
  }

  return { proposalId: proposal.id, confirmation };
}
