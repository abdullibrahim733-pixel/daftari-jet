/**
 * Record detail.
 *
 * Everything a reviewer needs to defend a record in one response: the current
 * values, the typed detail, the source it came from, the customer and deni
 * position, and the full version history with the previous snapshots. The
 * snapshot history is why "correct" never has to overwrite anything.
 */

import { requireTenant, tenantOf } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import {
  findLedgerRecordById,
  hydrateLedgerRecord,
} from '@/server/repositories/ledger.repository';
import { listAuditEvents } from '@/server/repositories/platform.repository';
import { listObligationsForRecord, listPaymentsForCustomer } from '@/server/repositories/debt.repository';
import {
  findProposalById,
  findTranscriptBySourceEvent,
  transcriptIsCorrected,
  transcriptText,
} from '@/server/repositories/source.repository';
import { recordHistory } from '@/server/services/corrections';
import { notFound } from '@/lib/errors';
import { ok, route } from '@/server/http/route';

export const GET = route<{ recordId: string }>(async (_request, { params }) => {
  const { recordId } = await params;
  const { db, context } = await requireTenant();
  assertCan(context.role, 'records.read');

  const scope = tenantOf(context);
  const record = await findLedgerRecordById(db, scope, recordId);
  if (!record) throw notFound('Record not found');

  const hydrated = await hydrateLedgerRecord(db, record);
  const obligation = (await listObligationsForRecord(db, scope, record.id))[0] ?? null;
  const proposal = record.proposal_id ? await findProposalById(db, scope, record.proposal_id) : undefined;
  const transcript = record.source_event_id
    ? await findTranscriptBySourceEvent(db, scope, record.source_event_id)
    : undefined;
  const payments = record.customer_id
    ? (await listPaymentsForCustomer(db, scope, record.customer_id)).filter(
        (payment) => payment.ledger_record_id === record.id,
      )
    : [];

  return ok({
    record: {
      id: record.id,
      recordType: record.record_type,
      occurredAt: record.occurred_at,
      currency: record.currency,
      amountMinor: record.amount_minor,
      description: record.description,
      status: record.status,
      origin: record.origin,
      version: record.version,
      confirmedAt: record.confirmed_at,
      confirmedByName: hydrated.confirmedByName,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
      supersedesRecordId: record.supersedes_record_id,
      reversesRecordId: record.reverses_record_id,
    },
    detail: hydrated.detail,
    customer: hydrated.customerName
      ? { id: record.customer_id, displayName: hydrated.customerName }
      : null,
    payeeName: record.payee_name,
    source: {
      sourceEventId: record.source_event_id,
      proposalId: record.proposal_id,
      proposalState: proposal?.state ?? null,
      // The transcript is the evidence a reviewer needs to trust the record, so
      // the detail view carries it while the list stays small.
      transcript: transcript ? transcriptText(transcript) : null,
      transcriptWasCorrected: transcript ? transcriptIsCorrected(transcript) : null,
      transcriptStatus: transcript?.status ?? null,
      proposalVersion: proposal?.version ?? null,
      ambiguityNote: proposal?.ambiguity_note ?? null,
    },
    deni: obligation
      ? {
          obligationId: obligation.id,
          originalAmountMinor: obligation.original_amount_minor,
          paidMinor: obligation.paid_minor,
          outstandingMinor: obligation.original_amount_minor - obligation.paid_minor,
          // A voided obligation is shown so the history explains itself, but it
          // is clearly marked as no longer counting towards the balance.
          state: obligation.state,
          dueDate: obligation.due_date,
        }
      : null,
    payments: payments.map((payment) => ({
      id: payment.id,
      amountMinor: payment.amount_minor,
      method: payment.method,
      receivedAt: payment.received_at,
      obligationId: payment.obligation_id,
    })),
    audit: (await listAuditEvents(db, scope, { entityType: 'ledger_record', entityId: record.id, limit: 50 })).map(
      (event) => ({
        id: event.id,
        action: event.action,
        actorName: event.actor_name,
        reasonCode: event.reason_code,
        reasonNote: event.reason_note,
        eventTime: event.event_time,
      }),
    ),
    history: await recordHistory(db, context, record.id),
  });
});
