/**
 * Rejects a proposal.
 *
 * Rejection never touches the ledger, and it always stores a reason so the
 * merchant can see why something was not recorded and an operator can tell a
 * genuine mistake from a broken transcription.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { rejectProposal } from '@/server/services/confirmation';
import { ok, parseBody, route } from '@/server/http/route';
import { rejectBodySchema } from '@/server/http/schemas';

export const POST = route<{ proposalId: string }>(async (request, { params }) => {
  const { proposalId } = await params;
  const { db, context } = await requireTenant();
  assertCan(context.role, 'proposals.review');

  const body = await parseBody(request, rejectBodySchema);
  const proposal = await rejectProposal(db, context, {
    proposalId,
    expectedVersion: body.expectedVersion,
    rejectedByUserId: context.userId,
    reasonCode: body.reasonCode,
    reasonNote: body.note ?? null,
  });

  return ok({
    id: proposal.id,
    state: proposal.state,
    rejectionReasonCode: proposal.rejection_reason_code,
    decidedAt: proposal.decided_at,
  });
});
