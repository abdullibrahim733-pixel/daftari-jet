/**
 * Inventory persistence (feature-gated, P2).
 *
 * Stock on hand is derived from confirmed movements rather than stored, so a
 * voided or reversed movement can never leave a phantom balance.
 */

import { all, get, run, type Db } from '@/server/db/client';
import { newId, nowIso, toSqlBool, fromSqlBool } from '@/server/db/ids';
import type { TenantScope } from '@/server/business-context/context';
import type { MovementType } from '@/server/domain/types';

export type InventoryItemRow = {
  id: string;
  business_id: string;
  name: string;
  unit: string;
  sku: string | null;
  low_stock_threshold_milli: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
};

export type InventoryMovementRow = {
  id: string;
  business_id: string;
  item_id: string;
  ledger_record_id: string | null;
  movement_type: MovementType;
  quantity_milli: number;
  unit_cost_minor: number | null;
  note: string | null;
  occurred_at: string;
  created_at: string;
};

export type ItemWithBalance = {
  item: InventoryItemRow;
  onHandMilli: number;
  lowStock: boolean;
  lastMovementAt: string | null;
};

export async function listItems(db: Db, scope: TenantScope): Promise<InventoryItemRow[]> {
  return await all<InventoryItemRow>(
    db,
    'SELECT * FROM inventory_items WHERE business_id = ? ORDER BY name',
    [scope.businessId],
  );
}

export async function findItemById(db: Db, scope: TenantScope, itemId: string): Promise<InventoryItemRow | undefined> {
  return await get<InventoryItemRow>(db, 'SELECT * FROM inventory_items WHERE id = ? AND business_id = ?', [
    itemId,
    scope.businessId,
  ]);
}

export async function findItemByName(db: Db, scope: TenantScope, name: string): Promise<InventoryItemRow | undefined> {
  return await get<InventoryItemRow>(
    db,
    'SELECT * FROM inventory_items WHERE business_id = ? AND name = ? COLLATE NOCASE',
    [scope.businessId, name.trim()],
  );
}

export async function createItem(
  db: Db,
  scope: TenantScope,
  input: { name: string; unit: string; sku?: string | null; lowStockThresholdMilli?: number | null },
): Promise<InventoryItemRow> {
  const id = newId('itm');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO inventory_items (
       id, business_id, name, unit, sku, low_stock_threshold_milli, is_active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      scope.businessId,
      input.name.trim(),
      input.unit.trim(),
      input.sku ?? null,
      input.lowStockThresholdMilli ?? null,
      timestamp,
      timestamp,
    ],
  );
  return await get<InventoryItemRow>(db, 'SELECT * FROM inventory_items WHERE id = ?', [id]) as InventoryItemRow;
}

export async function setItemThreshold(db: Db, itemId: string, thresholdMilli: number | null): Promise<void> {
  await run(db, 'UPDATE inventory_items SET low_stock_threshold_milli = ?, updated_at = ? WHERE id = ?', [
    thresholdMilli,
    nowIso(),
    itemId,
  ]);
}

export async function setItemActive(db: Db, itemId: string, active: boolean): Promise<void> {
  await run(db, 'UPDATE inventory_items SET is_active = ?, updated_at = ? WHERE id = ?', [
    toSqlBool(active),
    nowIso(),
    itemId,
  ]);
}

export async function itemsWithBalances(db: Db, scope: TenantScope): Promise<ItemWithBalance[]> {
  const items = await listItems(db, scope);
  return Promise.all(items.map(async (item) => {
    const totals = await get<{ on_hand: number | null; last_movement: string | null }>(
      db,
      `SELECT COALESCE(SUM(m.quantity_milli), 0) AS on_hand, MAX(m.occurred_at) AS last_movement
       FROM inventory_movements m
       JOIN ledger_records r ON r.id = m.ledger_record_id
       WHERE m.business_id = ? AND m.item_id = ? AND r.status = 'posted'`,
      [scope.businessId, item.id],
    );
    const onHandMilli = totals?.on_hand ?? 0;
    const threshold = item.low_stock_threshold_milli;
    return {
      item,
      onHandMilli,
      lowStock: threshold !== null && onHandMilli <= threshold,
      lastMovementAt: totals?.last_movement ?? null,
    };
  }));
}

export async function listMovementsForItem(
  db: Db,
  scope: TenantScope,
  itemId: string,
  limit = 50,
): Promise<InventoryMovementRow[]> {
  return await all<InventoryMovementRow>(
    db,
    `SELECT m.* FROM inventory_movements m
     JOIN ledger_records r ON r.id = m.ledger_record_id
     WHERE m.business_id = ? AND m.item_id = ? AND r.status = 'posted'
     ORDER BY m.occurred_at DESC LIMIT ?`,
    [scope.businessId, itemId, limit],
  );
}

export type InsertMovementInput = {
  businessId: string;
  itemId: string;
  ledgerRecordId: string | null;
  movementType: MovementType;
  quantityMilli: number;
  unitCostMinor: number | null;
  note: string | null;
  occurredAt: string;
};

/**
 * Records one stock movement. `quantity_milli` is always positive; direction comes
 * from `movement_type` so a sign can never be lost or flipped by a caller.
 */
export async function insertMovement(db: Db, input: InsertMovementInput): Promise<InventoryMovementRow> {
  if (!Number.isInteger(input.quantityMilli) || input.quantityMilli <= 0) {
    throw new Error('Movement quantity must be a positive integer in milli-units');
  }
  const id = newId('mov');
  await run(
    db,
    `INSERT INTO inventory_movements (
       id, business_id, item_id, ledger_record_id, movement_type, quantity_milli,
       unit_cost_minor, note, occurred_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.businessId,
      input.itemId,
      input.ledgerRecordId,
      input.movementType,
      input.quantityMilli,
      input.unitCostMinor,
      input.note,
      input.occurredAt,
      nowIso(),
    ],
  );
  return await get<InventoryMovementRow>(db, 'SELECT * FROM inventory_movements WHERE id = ?', [id]) as InventoryMovementRow;
}

export async function countLowStockItems(db: Db, scope: TenantScope): Promise<number> {
  return (await itemsWithBalances(db, scope)).filter((entry) => entry.lowStock).length;
}

export function itemIsActive(row: InventoryItemRow): boolean {
  return fromSqlBool(row.is_active);
}