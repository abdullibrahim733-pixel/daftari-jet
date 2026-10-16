/**
 * Inventory service (feature-gated, P2).
 *
 * Stock on hand is always derived from confirmed movements (never stored), so a
 * voided or reversed movement can never leave a phantom balance. These
 * operations manage the item list itself; movements come from the same
 * confirmation path as reviewable proposals.
 */

import { withTransaction, type Db } from '@/server/db/client';
import { assertPermission, type BusinessContext } from '@/server/business-context/context';
import { featureNotEnabled, notFound, validationFailed } from '@/lib/errors';
import {
  createItem,
  findItemById,
  findItemByName,
  itemsWithBalances,
  setItemActive,
  setItemThreshold,
  type ItemWithBalance,
} from '@/server/repositories/inventory.repository';
import { recordAuditSafely } from '@/server/services/audit';

export type InventoryItemSummary = {
  itemId: string;
  name: string;
  unit: string;
  sku: string | null;
  onHandMilli: number;
  lowStock: boolean;
  lowStockThresholdMilli: number | null;
  lastMovementAt: string | null;
};

export type InventoryOverview = {
  items: InventoryItemSummary[];
  trackedItems: number;
  lowStockCount: number;
};

function assertFeatureEnabled(context: BusinessContext): void {
  if (!context.features.inventory) {
    throw featureNotEnabled('inventory');
  }
}

function assertCanManage(context: BusinessContext): void {
  assertPermission(context, 'inventory.manage');
}

function toSummary(entry: ItemWithBalance): InventoryItemSummary {
  return {
    itemId: entry.item.id,
    name: entry.item.name,
    unit: entry.item.unit,
    sku: entry.item.sku,
    onHandMilli: entry.onHandMilli,
    lowStock: entry.lowStock,
    lowStockThresholdMilli: entry.item.low_stock_threshold_milli,
    lastMovementAt: entry.lastMovementAt,
  };
}

export async function inventoryOverview(db: Db, context: BusinessContext): Promise<InventoryOverview> {
  assertFeatureEnabled(context);
  const entries = await itemsWithBalances(db, { businessId: context.businessId });
  return {
    items: entries.map(toSummary),
    trackedItems: entries.length,
    lowStockCount: entries.filter((entry) => entry.lowStock).length,
  };
}

export type CreateInventoryItemInput = {
  name: string;
  unit: string;
  sku?: string | null;
  lowStockThresholdMilli?: number | null;
};

export async function createInventoryItem(
  db: Db,
  context: BusinessContext,
  input: CreateInventoryItemInput,
): Promise<InventoryItemSummary> {
  assertFeatureEnabled(context);
  assertCanManage(context);

  const existing = await findItemByName(db, { businessId: context.businessId }, input.name);
  if (existing) {
    throw validationFailed('An item with this name already exists in this business');
  }

  const scope = { businessId: context.businessId };
  const row = await withTransaction(async () => {
    const created = await createItem(db, scope, {
      name: input.name,
      unit: input.unit,
      sku: input.sku ?? null,
      lowStockThresholdMilli: input.lowStockThresholdMilli ?? null,
    });
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'inventory_item.created',
      entityType: 'inventory_item',
      entityId: created.id,
      actorUserId: context.userId,
      source: 'dashboard',
      after: { name: created.name, unit: created.unit },
    });
    return created;
  }, db);

  return {
    itemId: row.id,
    name: row.name,
    unit: row.unit,
    sku: row.sku,
    onHandMilli: 0,
    lowStock: false,
    lowStockThresholdMilli: row.low_stock_threshold_milli,
    lastMovementAt: null,
  };
}

export type UpdateInventoryItemInput = {
  lowStockThresholdMilli?: number | null;
  active?: boolean;
};

/**
 * Updates an item's threshold or active state. The "low stock" flag is never
 * edited directly: it is derived from on-hand and the threshold, so the two can
 * never disagree about which items appear on the overview card.
 */
export async function updateInventoryItem(
  db: Db,
  context: BusinessContext,
  itemId: string,
  input: UpdateInventoryItemInput,
): Promise<InventoryItemSummary> {
  assertFeatureEnabled(context);
  assertCanManage(context);

  const scope = { businessId: context.businessId };
  const existing = await findItemById(db, scope, itemId);
  if (!existing) {
    throw notFound('Inventory item not found');
  }

  await withTransaction(async () => {
    if (input.lowStockThresholdMilli !== undefined) {
      await setItemThreshold(db, itemId, input.lowStockThresholdMilli);
    }
    if (input.active !== undefined) {
      await setItemActive(db, itemId, input.active);
    }
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'inventory_item.updated',
      entityType: 'inventory_item',
      entityId: itemId,
      actorUserId: context.userId,
      source: 'dashboard',
      after: input,
    });
  }, db);

  const entries = await itemsWithBalances(db, scope);
  const matched = entries.find((entry) => entry.item.id === itemId);
  if (!matched) {
    throw notFound('Inventory item not found');
  }
  return toSummary(matched);
}