/**
 * Inventory item updates (feature-gated, P2).
 *
 * Threshold and active state are edited, never the derived low-stock flag. The
 * record lives entirely inside the tenant scope: an id from another business
 * resolves to the same 404 as a missing id.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { assertCan } from '@/server/permissions/policy';
import { featureNotEnabled } from '@/lib/errors';
import { ok, parseBody, route } from '@/server/http/route';
import { inventoryItemUpdateBodySchema } from '@/server/http/schemas';
import { updateInventoryItem } from '@/server/services/inventory';

export const PATCH = route(async (request, routeContext) => {
  const { itemId } = await routeContext.params;
  if (!itemId) throw new Error('Missing itemId');
  const { db, context: business } = await requireTenant();
  assertCan(business.role, 'inventory.manage');
  if (!business.features.inventory) {
    throw featureNotEnabled('inventory');
  }

  const body = await parseBody(request, inventoryItemUpdateBodySchema);
  const item = await updateInventoryItem(db, business, itemId, {
    lowStockThresholdMilli: body.lowStockThresholdMilli ?? undefined,
    active: body.active ?? undefined,
  });
  return ok({ item });
});