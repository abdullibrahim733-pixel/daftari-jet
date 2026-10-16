/**
 * Test fixtures.
 *
 * Each test gets its own temporary SQLite file with the full migration
 * history applied, so no test can read or write another test's ledger.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { after } from 'node:test';
import { closeDatabase, getDatabase, type Db } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrations';
import { createBusiness, createMembership, createUser } from '@/server/repositories/business.repository';
import { contextForTesting } from '@/server/business-context/context';
import type { BusinessContext } from '@/server/business-context/context';
import type { Role } from '@/server/domain/types';

// Private media storage resolves its root from the environment, so it has to be
// redirected for the whole process or tests would write into the real data dir.
const testRoot = path.join(process.cwd(), '.daftari-test');
mkdirSync(testRoot, { recursive: true });
const mediaRoot = path.join(testRoot, `media-${process.pid}-${randomUUID()}`);
mkdirSync(mediaRoot, { recursive: true });
process.env.DAFTARI_DATA_DIR = mediaRoot;

export type Fixture = {
  db: Db;
  userId: string;
  businessId: string;
  context: BusinessContext;
  scope: { businessId: string };
  /** A second tenant, for isolation assertions. */
  other: { businessId: string; context: BusinessContext };
};

const cleanups: { dir: string }[] = [];

after(async () => {
  await closeDatabase();
  for (const { dir } of cleanups) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(mediaRoot, { recursive: true, force: true });
});

export async function createFixture(options?: {
  role?: Role;
  features?: Partial<BusinessContext['features']>;
  otherFeatures?: Partial<BusinessContext['features']>;
  timezone?: string;
}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), 'daftari-test-'));
  const db = getDatabase({ dataDir: dir, filename: 'test.db' });
  cleanups.push({ dir });
  await runMigrations(db);

  const user = await createUser(db, { providerSubject: 'test-subject', displayName: 'Test Owner' });
  const business = await createBusiness(db, {
    name: 'Test Duka',
    businessType: 'shop',
    features: options?.features,
    timezone: options?.timezone,
  });
  await createMembership(db, {
    businessId: business.id,
    userId: user.id,
    role: options?.role ?? 'owner',
  });

  const context = contextForTesting({
    businessId: business.id,
    userId: user.id,
    role: options?.role ?? 'owner',
    features: options?.features,
    timezone: options?.timezone,
  });

  // A second tenant in the same database: any missing tenant filter shows up
  // as the other business' data leaking through.
  const otherUser = await createUser(db, { providerSubject: 'other-subject', displayName: 'Other Owner' });
  const otherBusiness = await createBusiness(db, {
    name: 'Other Duka',
    businessType: 'shop',
    features: options?.otherFeatures,
  });
  await createMembership(db, { businessId: otherBusiness.id, userId: otherUser.id, role: 'owner' });
  const otherContext = contextForTesting({
    businessId: otherBusiness.id,
    userId: otherUser.id,
    role: 'owner',
    features: options?.otherFeatures,
  });

  return {
    db,
    userId: user.id,
    businessId: business.id,
    context,
    scope: { businessId: business.id },
    other: { businessId: otherBusiness.id, context: otherContext },
  };
}
