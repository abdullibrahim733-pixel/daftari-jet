/**
 * Requests an export.
 *
 * The request creates a job rather than a file, so a large range cannot time
 * out the browser. Generation runs as a job and the status route reports when
 * the signed download is ready.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { requestExport } from '@/server/services/exports';
import { idempotentResponse, parseIdempotencyKey, withIdempotency } from '@/server/services/idempotency';
import { ERROR_CODES, conflict, validationFailed } from '@/lib/errors';
import { created, parseBody, route } from '@/server/http/route';
import { exportBodySchema } from '@/server/http/schemas';

export const POST = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'reports.export');

  if (!context.features.exports) {
    throw validationFailed('Exports are not enabled for this business');
  }

  const body = await parseBody(request, exportBodySchema);
  const key = parseIdempotencyKey(request.headers.get('idempotency-key'), 'export.request');
  if (!key) {
    throw validationFailed('This export needs an Idempotency-Key header', {
      header: 'Idempotency-Key',
      code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    });
  }

  const result = await withIdempotency(
    db,
    { scope: `${key.scope}:${context.businessId}`, key: key.key },
    body,
    async () => {
      const job = await requestExport(db, context, body, context.userId);
      return {
        status: 202,
        body: {
          exportId: job.id,
          status: job.status,
          format: job.format,
          fromDate: job.from_date,
          toDate: job.to_date,
        },
      };
    },
  );

  if (result.kind === 'in_progress') {
    throw conflict(
      ERROR_CODES.IDEMPOTENT_REQUEST_IN_PROGRESS,
      'This export request is still being accepted. Try again in a moment.',
    );
  }
  const response = idempotentResponse(result);
  if (!response) throw conflict(ERROR_CODES.INTERNAL, 'The export request could not be read back');

  return created({ data: response.body, status: response.status });
});
