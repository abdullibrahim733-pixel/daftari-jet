/**
 * Inventory items (feature-gated, P2).
 *
 * The list endpoint reports whether inventory is enabled so the page can show a
 * clear gated state; managing items stays guarded by the `inventory.manage`
 * permission. Creating an item is idempotent so a double tap cannot create two
 * items, and names are unique per business to keep stock movements unmistakable.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { featureNotEnabled, validationFailed, conflict, ERROR_CODES } from '@/lib/errors';
import { ok, parseBody, route } from '@/server/http/route';
import { inventoryItemBodySchema } from '@/server/http/schemas';
import { createInventoryItem, inventoryOverview } from '@/server/services/inventory';
import { idempotentResponse, parseIdempotencyKey, withIdempotency } from '@/server/services/idempotency';

export const GET = route(async () => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'inventory.read');

  if (!context.features.inventory) {
    return ok({ enabled: false, overview: null });
  }

  return ok({ enabled: true, overview: await inventoryOverview(db, context) });
});

export const POST = route(async (request) => {
  const { db, context } = await requireTenant();
  assertCan(context.role, 'inventory.manage');
  if (!context.features.inventory) {
    throw featureNotEnabled('inventory');
  }

  const body = await parseBody(request, inventoryItemBodySchema);
  const key = parseIdempotencyKey(request.headers.get('idempotency-key'), 'inventory.item');
  if (!key) {
    throw validationFailed('This request needs an Idempotency-Key header', {
      header: 'Idempotency-Key',
      code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    });
  }

  const result = await withIdempotency(
    db,
    { scope: `${key.scope}:${context.businessId}`, key: key.key },
    body,
    async () => {
      const item = await createInventoryItem(db, context, body);
      return {
        status: 201,
        body: { item },
      };
    },
  );

  if (result.kind === 'in_progress') {
    throw conflict(
      ERROR_CODES.IDEMPOTENT_REQUEST_IN_PROGRESS,
      'This request is still being accepted. Try again in a moment.',
    );
  }
  const response = idempotentResponse(result);
  if (!response) throw conflict(ERROR_CODES.INTERNAL, 'The item could not be read back');

  return Response.json({ data: response.body }, { status: response.status });
});