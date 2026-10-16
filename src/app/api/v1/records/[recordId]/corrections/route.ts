/**
 * Creates a correction or a reversal.
 *
 * The client never sets a status directly. It says what it wants to change, with
 * a reason and the version it was looking at; the server decides whether that is
 * allowed, writes the new version or the reversal, and audits it. Two reviewers
 * acting on the same record cannot clobber each other: the second request loses
 * on the version check and gets a 409 telling it to reload.
 */

import { z } from 'zod';
import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { applyCorrection } from '@/server/services/corrections';
import { idempotentResponse, parseIdempotencyKey, withIdempotency } from '@/server/services/idempotency';
import { ERROR_CODES, conflict, validationFailed } from '@/lib/errors';
import { parseBody, route } from '@/server/http/route';

const correctionsSchema = z
  .object({
    action: z.enum(['correct', 'reverse']),
    expectedVersion: z.number().int().positive(),
    reasonCode: z.string().trim().min(1).max(60),
    reasonNote: z.string().trim().max(500).nullish(),
    fields: z
      .object({
        amountMinor: z.number().int().nonnegative().nullish(),
        occurredAt: z.string().datetime().nullish(),
        description: z.string().trim().max(300).nullish(),
        category: z.string().trim().max(80).nullish(),
        payee: z.string().trim().max(160).nullish(),
        customerId: z.string().trim().max(64).nullish(),
        customerName: z.string().trim().max(160).nullish(),
        paymentStatus: z.enum(['paid', 'partial', 'unpaid']).nullish(),
        paymentMethod: z.enum(['cash', 'mobile_money', 'bank', 'card', 'credit']).nullish(),
        amountPaidMinor: z.number().int().nonnegative().nullish(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        note: z.string().trim().max(500).nullish(),
      })
      .strict()
      .nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'reverse' && value.fields) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'A reversal does not take changed fields; it reverses the whole record',
      });
    }
    if (value.action === 'correct' && !value.fields) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'A correction needs the fields it changes',
      });
    }
    if (!value.reasonNote && value.reasonCode === 'other') {
      ctx.addIssue({
        code: 'custom',
        path: ['reasonNote'],
        message: 'Explain the correction when the reason is "other"',
      });
    }
  });

export const POST = route<{ recordId: string }>(async (request, { params }) => {
  const { recordId } = await params;
  const { db, context } = await requireTenant();
  assertCan(context.role, 'records.correct');

  const body = await parseBody(request, correctionsSchema);
  const key = parseIdempotencyKey(request.headers.get('idempotency-key'), `record.correction:${recordId}`);
  if (!key) {
    throw validationFailed('This change needs an Idempotency-Key header', {
      header: 'Idempotency-Key',
      code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    });
  }

  const result = await withIdempotency(
    db,
    { scope: `${key.scope}:${context.businessId}`, key: key.key },
    { ...body, recordId },
    async () => {
      const outcome = await applyCorrection(db, context, {
        recordId,
        expectedVersion: body.expectedVersion,
        action: body.action,
        reasonCode: body.reasonCode,
        reasonNote: body.reasonNote ?? null,
        fields: body.fields ?? undefined,
        actorUserId: context.userId,
      });

      // A correction that no longer satisfies the record rules is a validation
      // failure, not a saved change: nothing was written, so nothing is cached.
      if (outcome.issues) {
        throw validationFailed('The corrected values are not valid for this record', {
          issues: outcome.issues.map((issue) => `${issue.field}: ${issue.message}`),
        });
      }

      return {
        status: 200,
        body: {
          action: outcome.action,
          recordId: outcome.record.id,
          status: outcome.record.status,
          version: outcome.record.version,
          occurredAt: outcome.record.occurred_at,
          amountMinor: outcome.record.amount_minor,
          currency: outcome.record.currency,
        },
      };
    },
  );

  if (result.kind === 'in_progress') {
    throw conflict(
      ERROR_CODES.IDEMPOTENT_REQUEST_IN_PROGRESS,
      'This change is still being applied. Try again in a moment.',
    );
  }
  const response = idempotentResponse(result);
  if (!response) throw conflict(ERROR_CODES.INTERNAL, 'The change could not be read back');

  return Response.json({ data: response.body }, { status: response.status });
});
