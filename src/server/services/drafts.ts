/**
 * In-app draft handling.
 *
 * A recording captured while extraction is off becomes a draft proposal with no
 * guessed type. This service lets the reviewer classify that draft before it is
 * confirmed. It only touches proposals produced by the manual-draft adapter, so a
 * model proposal's type can never be silently rewritten.
 */

import type { Db } from '@/server/db/client';
import { conflict, notFound, validationFailed, ERROR_CODES } from '@/lib/errors';
import type { BusinessContext } from '@/server/business-context/context';
import { missingRequiredFields } from '@/lib/validation/proposal';
import { REVIEWABLE_PROPOSAL_STATES, type ProposalState, type RecordType } from '@/server/domain/types';
import {
  findProposalById,
  proposalFields,
  updateProposalDraft,
} from '@/server/repositories/source.repository';
import { MANUAL_DRAFT_PROVIDER } from '@/server/integrations/extraction/manual-draft-adapter';
import { recordAuditSafely } from './audit';

export type RetypeInput = {
  proposalId: string;
  expectedVersion: number;
  recordType: RecordType;
};

export type RetypeResult = {
  recordType: RecordType;
  state: ProposalState;
  missingFields: string[];
};

export async function retypeDraftProposal(
  db: Db,
  context: BusinessContext,
  input: RetypeInput,
): Promise<RetypeResult> {
  const scope = { businessId: context.businessId };
  const proposal = await findProposalById(db, scope, input.proposalId);
  if (!proposal) throw notFound('Proposal not found');
  if (!REVIEWABLE_PROPOSAL_STATES.includes(proposal.state)) {
    throw conflict(ERROR_CODES.PROPOSAL_NOT_REVIEWABLE, 'This proposal was already decided');
  }
  if (proposal.provider !== MANUAL_DRAFT_PROVIDER) {
    throw validationFailed('Only an in-app recording can be reclassified');
  }
  if (proposal.version !== input.expectedVersion) {
    throw conflict(
      ERROR_CODES.PROPOSAL_VERSION_CONFLICT,
      'This proposal changed since you opened it. Reload and review again.',
      { expectedVersion: input.expectedVersion, currentVersion: proposal.version },
    );
  }

  const fields = proposalFields(proposal);
  const missingFields = missingRequiredFields(input.recordType, fields);
  const state: ProposalState = missingFields.length > 0 ? 'needs_details' : 'needs_review';

  await updateProposalDraft(db, proposal.id, { recordType: input.recordType, state, missingFields });
  await recordAuditSafely(db, {
    businessId: context.businessId,
    action: 'proposal.edited',
    entityType: 'proposal',
    entityId: proposal.id,
    actorUserId: context.userId,
    before: { recordType: proposal.record_type, state: proposal.state },
    after: { recordType: input.recordType, state, missingFields },
  });

  return { recordType: input.recordType, state, missingFields };
}
