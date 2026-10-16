/**
 * Seeds a local development tenant.
 *
 * Creates (or reuses) a development owner, their business, a connected WhatsApp
 * integration, and a couple of inventory items, so the webhook -> proposal ->
 * confirm flow can be exercised end to end. Idempotent: running it twice does
 * not duplicate the tenant.
 *
 * Usage: npm run db:seed
 */

import { closeDatabase, getDatabase, type Db } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrations';
import { createItem, listItems } from '@/server/repositories/inventory.repository';
import {
  createBusiness,
  createMembership,
  createUser,
  findUserByProviderSubject,
  listBusinessesForUser,
  upsertIntegration,
  type BusinessRow,
} from '@/server/repositories/business.repository';

const PROVIDER = 'whatsapp';
const DEFAULT_SUBJECT = 'dev-owner';
const DEFAULT_DISPLAY_NAME = 'Daftari Owner';
const DEFAULT_BUSINESS_NAME = 'Daftari Demo Shop';
const DEFAULT_ACCOUNT_REF = '+255700000001';

async function seed(db: Db, env: NodeJS.ProcessEnv): Promise<void> {
  const subject = env.DAFTARI_SEED_SUBJECT?.trim() || DEFAULT_SUBJECT;
  const accountRef = env.DAFTARI_WHATSAPP_ACCOUNT_REF?.trim() || DEFAULT_ACCOUNT_REF;

  const user =
    (await findUserByProviderSubject(db, subject)) ??
    (await createUser(db, {
      providerSubject: subject,
      displayName: env.DAFTARI_SEED_DISPLAY_NAME?.trim() || DEFAULT_DISPLAY_NAME,
    }));

  const existing = (await listBusinessesForUser(db, user.id))[0];
  let business: BusinessRow;
  if (existing) {
    business = existing;
  } else {
    business = await createBusiness(db, {
      name: env.DAFTARI_SEED_BUSINESS_NAME?.trim() || DEFAULT_BUSINESS_NAME,
      businessType: 'shop',
      features: { inventory: true },
    });
    await createMembership(db, { businessId: business.id, userId: user.id, role: 'owner' });
  }

  const integration = await upsertIntegration(db, {
    businessId: business.id,
    provider: PROVIDER,
    externalAccountRef: accountRef,
    status: 'connected',
    scopes: ['messages'],
    consentGivenAt: new Date().toISOString(),
  });

  let items = await listItems(db, { businessId: business.id });
  if (items.length === 0) {
    await createItem(db, { businessId: business.id }, { name: 'Mchele', unit: 'kg' });
    await createItem(db, { businessId: business.id }, { name: 'Sukari', unit: 'kg' });
    items = await listItems(db, { businessId: business.id });
  }

  process.stdout.write('Seed complete.\n');
  process.stdout.write(`  user:        ${user.id} (${user.display_name}, subject "${subject}")\n`);
  process.stdout.write(`  business:    ${business.id} (${business.name})\n`);
  process.stdout.write(`  integration: ${integration.id} (${PROVIDER} @ ${accountRef})\n`);
  process.stdout.write(`  items:       ${items.map((item) => item.name).join(', ') || 'none'}\n`);
  process.stdout.write('Sign in via the dashboard, then send a WhatsApp message to trigger the pipeline.\n');
}

async function main(): Promise<void> {
  const db = getDatabase();
  await runMigrations(db);
  await seed(db, process.env);
  closeDatabase();
}

await main();
