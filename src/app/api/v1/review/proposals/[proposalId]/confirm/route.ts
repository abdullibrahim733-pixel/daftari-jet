/**
 * Confirms a reviewed proposal into the ledger.
 *
 * This is the only endpoint that turns a proposal into money in the books, so
 * it is idempotent (a retried confirm cannot post twice), it requires the
 * proposal version the reviewer actually saw (a stale view is a conflict, not a
 * silent overwrite), and it records who confirmed it.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { confirmProposal } from '@/server/services/confirmation';
import { parseIdempotencyKey, idempotentResponse, withIdempotency } from '@/server/services/idempotency';
import { ERROR_CODES, conflict, validationFailed } from '@/lib/errors';
import { parseBody, route } from '@/server/http/route';
import { confirmBodySchema } from '@/server/http/schemas';

export const POST = route<{ proposalId: string }>(async (request, { params }) => {
  const { proposalId } = await params;
  const { db, context } = await requireTenant();
  assertCan(context.role, 'proposals.review');

  const body = await parseBody(request, confirmBodySchema);
  const key = parseIdempotencyKey(request.headers.get('idempotency-key'), 'proposal.confirm');
  if (!key) {
    throw validationFailed('This confirmation needs an Idempotency-Key header', {
      header: 'Idempotency-Key',
      code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    });
  }

  const result = await withIdempotency(
    db,
    { scope: `${key.scope}:${context.businessId}`, key: key.key },
    { proposalId, ...body },
    async () => {
      const outcome = await confirmProposal(db, context, {
        proposalId,
        expectedVersion: body.expectedVersion,
        confirmedByUserId: context.userId,
        fields: body.fields ?? undefined,
        note: body.note ?? null,
      });

      if (outcome.kind === 'invalid') {
        throw validationFailed('Some fields need attention before this can be confirmed', {
          fields: outcome.issues.map((issue) => `${issue.field}: ${issue.message}`),
        });
      }

      return {
        status: 200,
        body: {
          result: outcome.kind,
          recordId: outcome.kind === 'confirmed' ? outcome.record.id : outcome.recordId,
          customerId: outcome.kind === 'confirmed' ? outcome.customer?.id ?? null : null,
        },
      };
    },
  );

  if (result.kind === 'in_progress') {
    throw conflict(
      ERROR_CODES.IDEMPOTENT_REQUEST_IN_PROGRESS,
      'This confirmation is still being processed. Try again in a moment.',
    );
  }

  const response = idempotentResponse(result);
  if (!response) throw conflict(ERROR_CODES.INTERNAL, 'The confirmation could not be read back');

  return Response.json({ data: response.body }, { status: response.status });
});
