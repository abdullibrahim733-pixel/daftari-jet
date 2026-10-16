/**
 * Applies pending migrations and prints the resulting state.
 *
 * Usage: npm run db:migrate
 */

import { closeDatabase, getDatabase, type Db } from '@/server/db/client';
import { appliedMigrations, currentMigration, runMigrations } from '@/server/db/migrations';

async function main(): Promise<void> {
  const db: Db = getDatabase();
  // A brand new database has no migration table yet, so migrate before reading
  // the applied list.
  const applied = await runMigrations(db);
  const schema = await appliedMigrations(db);
  process.stdout.write(`Data directory: ${process.env.DAFTARI_DATA_DIR ?? '.daftari'}\n`);
  process.stdout.write(
    applied.length > 0 ? `Applied now: ${applied.join(', ')}\n` : 'Applied now: nothing (up to date)\n',
  );
  process.stdout.write(`Schema version: ${schema.join(', ') || 'none'}\n`);
  process.stdout.write(`Current version: ${await currentMigration(db) ?? 'none'}\n`);
  closeDatabase();
}

await main();