/**
 * Inventory (feature-gated, P2).
 *
 * These tests pin the promises that make inventory safe to surface: it is
 * completely invisible until enabled, item names stay unique per business so a
 * stock movement is never ambiguous, managers can read but only owners (and
 * granted managers) manage, "low stock" always comes from on-hand against the
 * threshold (never an editable flag), and one tenant can never see or touch
 * another tenant's item.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, type Fixture } from './helpers/fixture';
import { confirmProposal } from '@/server/services/confirmation';
import { ERROR_CODES, AppError } from '@/lib/errors';
import { emptyProposalFields, missingRequiredFields, type ProposalFields } from '@/lib/validation/proposal';
import { insertProposal, insertSourceEvent } from '@/server/repositories/source.repository';
import { createItem as _createItem } from '@/server/repositories/inventory.repository';
import {
  createInventoryItem,
  inventoryOverview,
  updateInventoryItem,
} from '@/server/services/inventory';

let eventCounter = 0;

async function throwCode(db: () => Promise<unknown>): Promise<AppError> {
  try {
    await db();
    assert.fail('expected the operation to throw');
    throw new Error('unreachable');
  } catch (caught) {
    assert.ok(caught instanceof AppError, 'the operation must fail with an AppError');
    return caught;
  }
}

async function stockIn(
  fixture: Fixture,
  itemName: string,
  quantityMilli: number,
  unit: string,
): Promise<void> {
  const { db, businessId } = fixture;
  eventCounter += 1;
  const sourceEvent = await insertSourceEvent(db, {
    businessId,
    integrationId: null,
    providerEventId: `evt_inv_${eventCounter}`,
    eventType: 'message',
    senderRef: '+255700000001',
    receivedAt: '2026-03-10T08:00:00.000Z',
    providerSentAt: '2026-03-10T08:00:00.000Z',
    dedupeKey: `test:inventory:${eventCounter}`,
    redactedPayload: null,
  });
  const fields: ProposalFields = {
    ...emptyProposalFields('TZS'),
    amountMinor: null,
    occurredAt: '2026-03-10T08:00:00.000Z',
    occurredAtBasis: 'explicit',
    paymentStatus: null,
    description: 'Stock in',
    itemName,
    quantityMilli,
    unit,
    movementType: 'in',
  };
  const proposal = await insertProposal(db, {
    businessId,
    sourceEventId: sourceEvent.id,
    transcriptId: null,
    recordType: 'stock_movement',
    state: 'needs_review',
    schemaVersion: '1',
    provider: 'test',
    modelVersion: 'test',
    fields,
    provenance: {},
    missingFields: missingRequiredFields('stock_movement', fields),
    validationIssues: [],
    duplicateCandidates: [],
  });
  const result = await confirmProposal(db, fixture.context, {
    proposalId: proposal.id,
    expectedVersion: proposal.version,
    confirmedByUserId: fixture.userId,
  });
  assert.equal(result.kind, 'confirmed');
}

describe('inventory service', () => {
  it('is invisible until the feature is enabled', async () => {
    const fixture = await createFixture(); // inventory defaults to off
    const error = await throwCode(async () => await inventoryOverview(fixture.db, fixture.context));
    assert.equal(error.code, ERROR_CODES.FEATURE_NOT_ENABLED);
  });

  it('lists a created item with zero on hand and no low-stock flag', async () => {
    const fixture = await createFixture({ features: { inventory: true } });
    await createInventoryItem(fixture.db, fixture.context, { name: 'Rice', unit: 'bag' });

    const overview = await inventoryOverview(fixture.db, fixture.context);
    assert.equal(overview.trackedItems, 1);
    assert.equal(overview.lowStockCount, 0);
    assert.equal(overview.items[0]?.name, 'Rice');
    assert.equal(overview.items[0]?.unit, 'bag');
    assert.equal(overview.items[0]?.onHandMilli, 0);
    assert.equal(overview.items[0]?.lowStock, false);
  });

  it('rejects a duplicate item name within the same business', async () => {
    const fixture = await createFixture({ features: { inventory: true } });
    await createInventoryItem(fixture.db, fixture.context, { name: 'Rice', unit: 'bag' });

    const error = await throwCode(async () =>
      await createInventoryItem(fixture.db, fixture.context, { name: ' rice ', unit: 'kg' }),
    );
    assert.equal(error.status, 422);
  });

  it('allows the same item name in a different business', async () => {
    const fixture = await createFixture({
      features: { inventory: true },
      otherFeatures: { inventory: true },
    });
    await createInventoryItem(fixture.db, fixture.other.context, { name: 'Rice', unit: 'bag' });

    const overview = await inventoryOverview(fixture.db, fixture.context);
    assert.equal(overview.trackedItems, 0, "another business' item must not leak through");
  });

  it('derives on hand and low stock from confirmed movements', async () => {
    const fixture = await createFixture({ features: { inventory: true } });
    const item = await createInventoryItem(fixture.db, fixture.context, {
      name: 'Rice',
      unit: 'kg',
      lowStockThresholdMilli: 5_000,
    });
    await stockIn(fixture, 'Rice', 2_000, 'kg');

    const overview = await inventoryOverview(fixture.db, fixture.context);
    const rice = overview.items.find((entry) => entry.itemId === item.itemId);
    assert.ok(rice, 'the item must appear with a balance');
    assert.equal(rice?.onHandMilli, 2_000);
    assert.equal(rice?.lowStock, true, 'on hand below the threshold must flag low stock');
  });

  it('raises low stock only when on hand reaches the threshold', async () => {
    const fixture = await createFixture({ features: { inventory: true } });
    const item = await createInventoryItem(fixture.db, fixture.context, {
      name: 'Sugar',
      unit: 'kg',
      lowStockThresholdMilli: 2_000,
    });
    await stockIn(fixture, 'Sugar', 2_000, 'kg');

    const overview = await inventoryOverview(fixture.db, fixture.context);
    assert.equal(
      overview.items.find((entry) => entry.itemId === item.itemId)?.lowStock,
      true,
      'at-or-below the threshold is low stock',
    );
  });

  it('does not count movements of another tenant', async () => {
    const fixture = await createFixture({
      features: { inventory: true },
      otherFeatures: { inventory: true },
    });
    const item = await createInventoryItem(fixture.db, fixture.context, { name: 'Rice', unit: 'kg' });
    await stockIn(fixture, 'Rice', 50_000, 'kg');

    const otherOverview = await inventoryOverview(fixture.db, fixture.other.context);
    assert.equal(
      otherOverview.trackedItems,
      0,
      "the other business must never see this tenant's inventory",
    );
    const overview = await inventoryOverview(fixture.db, fixture.context);
    assert.equal(overview.items.find((entry) => entry.itemId === item.itemId)?.onHandMilli, 50_000);
  });

  it('only the owner can manage items', async () => {
    const fixture = await createFixture({ role: 'staff', features: { inventory: true } });
    const error = await throwCode(async () =>
      await createInventoryItem(fixture.db, fixture.context, { name: 'Rice', unit: 'bag' }),
    );
    assert.equal(error.status, 403, 'staff must not create inventory items');
  });

  it('manager can read inventory but not manage it', async () => {
    const fixture = await createFixture({ role: 'manager', features: { inventory: true } });
    const overview = await inventoryOverview(fixture.db, fixture.context);
    assert.equal(overview.trackedItems, 0, "the manager's own empty business has no items");

    const error = await throwCode(async () =>
      await createInventoryItem(fixture.db, fixture.context, { name: 'Sugar', unit: 'bag' }),
    );
    assert.equal(error.status, 403, 'manager must not manage inventory without a grant');
  });

  it('updates the threshold and drives the low-stock flag', async () => {
    const fixture = await createFixture({ features: { inventory: true } });
    const item = await createInventoryItem(fixture.db, fixture.context, { name: 'Salt', unit: 'bag' });
    await stockIn(fixture, 'Salt', 3_000, 'bag');

    let overview = await inventoryOverview(fixture.db, fixture.context);
    assert.equal(overview.items[0]?.lowStock, false, 'no threshold yet means never low stock');

    const updated = await updateInventoryItem(fixture.db, fixture.context, item.itemId, {
      lowStockThresholdMilli: 3_000,
    });
    assert.equal(updated.lowStockThresholdMilli, 3_000);

    overview = await inventoryOverview(fixture.db, fixture.context);
    assert.equal(overview.items[0]?.lowStock, true, 'threshold 3,000 with 3,000 on hand is low stock');
  });

  it('cannot reach another tenant item when updating', async () => {
    const fixture = await createFixture({
      features: { inventory: true },
      otherFeatures: { inventory: true },
    });
    const item = await createInventoryItem(fixture.db, fixture.context, { name: 'Rice', unit: 'bag' });

    const error = await throwCode(async () =>
      await updateInventoryItem(fixture.db, fixture.other.context, item.itemId, { active: false }),
    );
    assert.equal(error.status, 404, 'a cross-tenant item must look absent');
  });
});