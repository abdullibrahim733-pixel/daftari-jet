/**
 * One proposal, with everything a reviewer needs to decide.
 *
 * The transcript is included so the merchant can hear or read what the system
 * actually heard before confirming it, and the source span of every field is
 * included so a correction can be made against the evidence.
 */

import { requireTenant, tenantOf } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { notFound } from '@/lib/errors';
import {
  findProposalById,
  findSourceEventById,
  findTranscriptBySourceEvent,
  proposalFields,
  proposalMissingFields,
  proposalProvenance,
} from '@/server/repositories/source.repository';
import { listCustomers } from '@/server/repositories/debt.repository';
import { listItems } from '@/server/repositories/inventory.repository';
import { retypeDraftProposal } from '@/server/services/drafts';
import { ok, parseBody, route } from '@/server/http/route';
import { retypeBodySchema } from '@/server/http/schemas';

export const GET = route<{ proposalId: string }>(async (_request, { params }) => {
  const { proposalId } = await params;
  const { db, context } = await requireTenant();
  assertCan(context.role, 'proposals.read');

  const scope = tenantOf(context);
  const proposal = await findProposalById(db, scope, proposalId);
  if (!proposal) throw notFound('Proposal not found');

  const sourceEvent = proposal.source_event_id
    ? await findSourceEventById(db, scope, proposal.source_event_id)
    : undefined;
  const transcript = proposal.source_event_id
    ? await findTranscriptBySourceEvent(db, scope, proposal.source_event_id)
    : undefined;

  return ok({
    proposal: {
      id: proposal.id,
      state: proposal.state,
      recordType: proposal.record_type,
      version: proposal.version,
      schemaVersion: proposal.schema_version,
      provider: proposal.provider,
      modelVersion: proposal.model_version,
      ambiguityNote: proposal.ambiguity_note,
      missingFields: proposalMissingFields(proposal),
      fields: proposalFields(proposal),
      provenance: proposalProvenance(proposal),
      confirmedLedgerRecordId: proposal.confirmed_ledger_record_id,
      rejectionReasonCode: proposal.rejection_reason_code,
      decidedAt: proposal.decided_at,
      createdAt: proposal.created_at,
      updatedAt: proposal.updated_at,
    },
    sourceEvent: sourceEvent
      ? {
          id: sourceEvent.id,
          kind: sourceEvent.event_type,
          senderRef: sourceEvent.sender_ref,
          receivedAt: sourceEvent.received_at,
          status: sourceEvent.status,
        }
      : null,
    transcript: transcript
      ? {
          id: transcript.id,
          status: transcript.status,
          language: transcript.detected_language,
          text: transcript.machine_text,
          failureCode: transcript.failure_code,
        }
      : null,
    /** Options the reviewer can pick instead of typing free text. */
    options: {
      customers: (await listCustomers(db, scope)).map((customer) => ({
        id: customer.id,
        displayName: customer.display_name,
      })),
      items: context.features.inventory
        ? (await listItems(db, scope)).map((item) => ({ id: item.id, name: item.name, unit: item.unit }))
        : [],
      features: context.features,
      timezone: context.timezone,
      currency: context.currency,
    },
  });
});

/**
 * Reclassifies an in-app recording draft before it is confirmed.
 *
 * A proposal captured while extraction is off has no guessed type, so the
 * reviewer chooses one here; the form and missing-field cues then follow.
 */
export const PATCH = route<{ proposalId: string }>(async (request, { params }) => {
  const { proposalId } = await params;
  const { db, context } = await requireTenant();
  assertCan(context.role, 'proposals.review');

  const body = await parseBody(request, retypeBodySchema);
  const result = await retypeDraftProposal(db, context, {
    proposalId,
    expectedVersion: body.expectedVersion,
    recordType: body.recordType,
  });
  return ok(result);
});
