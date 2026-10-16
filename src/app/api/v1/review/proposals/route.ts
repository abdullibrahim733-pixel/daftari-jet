/**
 * Review queue listing.
 *
 * The queue is the merchant's work list, so the ordering guarantees are
 * explicit: oldest first by default, because a message that arrived yesterday
 * matters more than one that arrived a minute ago.
 */

import { requireTenant, tenantOf } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import {
  countProposalsByState,
  listProposals,
  proposalFields,
  proposalMissingFields,
} from '@/server/repositories/source.repository';
import { validationFailed } from '@/lib/errors';
import { ok, queryInt, queryList, queryParam, route } from '@/server/http/route';
import { RECORD_TYPES, SOURCE_KINDS, PROPOSAL_STATES, type ProposalState, type RecordType, type SourceKind } from '@/server/domain/types';

function statesFromQuery(request: Request): ProposalState[] {
  const requested = queryList(request, 'states');
  if (requested.length === 0) return ['needs_review', 'needs_details', 'duplicate'];
  for (const state of requested) {
    if (!(PROPOSAL_STATES as readonly string[]).includes(state)) {
      throw validationFailed(`Unknown proposal state: ${state}`, {
        allowed: [...PROPOSAL_STATES],
      });
    }
  }
  return requested as ProposalState[];
}

function recordTypeFromQuery(request: Request): RecordType | undefined {
  const requested = queryParam(request, 'recordType');
  if (requested === null) return undefined;
  if (!(RECORD_TYPES as readonly string[]).includes(requested)) {
    throw validationFailed(`Unknown record type: ${requested}`, { allowed: [...RECORD_TYPES] });
  }
  return requested as RecordType;
}

function sourceKindFromQuery(request: Request): SourceKind | undefined {
  const requested = queryParam(request, 'sourceKind');
  if (requested === null) return undefined;
  if (!(SOURCE_KINDS as readonly string[]).includes(requested)) {
    throw validationFailed(`Unknown source kind: ${requested}`, { allowed: [...SOURCE_KINDS] });
  }
  return requested as SourceKind;
}

export const GET = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'proposals.read');

  const states = statesFromQuery(request);
  const cursor = queryParam(request, 'cursorCreatedAt');
  const cursorId = queryParam(request, 'cursorId');
  const order = queryParam(request, 'order') === 'newest_first' ? 'newest_first' : 'oldest_first';
  const limit = queryInt(request, 'limit', 25, 100);

  const proposals = await listProposals(db, tenantOf(context), {
    states,
    recordType: recordTypeFromQuery(request),
    sourceKind: sourceKindFromQuery(request),
    receivedFrom: queryParam(request, 'receivedFrom') ?? undefined,
    receivedTo: queryParam(request, 'receivedTo') ?? undefined,
    confidenceBand: (queryParam(request, 'confidenceBand') as 'low' | 'medium' | 'high' | null) ?? undefined,
    limit: limit + 1,
    order,
    cursor: cursor && cursorId ? { createdAt: cursor, id: cursorId } : null,
  });

  const hasMore = proposals.length > limit;
  const page = hasMore ? proposals.slice(0, limit) : proposals;
  const last = page.at(-1);

  return ok({
    proposals: page.map((row) => {
      const fields = proposalFields(row);
      const sourceKind = SOURCE_KINDS.find((kind) => kind === row.source_event_type)
        ?? (row.provider === 'import' ? 'import' : 'manual');
      return {
        id: row.id,
        state: row.state,
        recordType: row.record_type,
        sourceEventId: row.source_event_id,
        transcriptId: row.transcript_id,
        sourceKind,
        amountMinor: fields.amountMinor,
        currency: fields.currency,
        occurredAtHint: fields.occurredAt,
        customerNameHint: fields.customerName,
        ambiguityNote: row.ambiguity_note,
        missingFields: proposalMissingFields(row),
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }),
    counts: await countProposalsByState(db, tenantOf(context)),
    page: {
      limit,
      order,
      hasMore,
      nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
    },
  });
});
