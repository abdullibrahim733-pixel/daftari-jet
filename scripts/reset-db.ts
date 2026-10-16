/**
 * Resets the local database to an empty, migrated state.
 *
 * SQLite: deletes the database file (and its WAL sidecars) and re-runs
 * migrations. PostgreSQL: refuses unless explicitly confirmed, because dropping
 * the schema destroys real data.
 *
 * Usage:
 *   npm run db:reset                 # SQLite only
 *   DAFTARI_RESET_CONFIRM=yes npm run db:reset -- --force   # also PostgreSQL
 */

import { existsSync, rmSync } from 'node:fs';
import { closeDatabase, databasePath, getDatabase, resolveDataDir, type Db } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrations';
import { exec } from '@/server/db/client';

function usesPostgres(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim() || process.env.NEON_DATABASE_URL?.trim());
}

async function resetSqlite(): Promise<void> {
  // Release the file handle before deleting it.
  await closeDatabase();
  const file = databasePath();
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    if (existsSync(candidate)) rmSync(candidate, { force: true });
  }
  process.stdout.write(`Deleted SQLite database at ${file}\n`);
  await runMigrations(getDatabase());
  process.stdout.write('Re-applied migrations.\n');
}

async function resetPostgres(db: Db): Promise<void> {
  process.stdout.write('Dropping and recreating schema "public" in PostgreSQL...\n');
  await exec(db, 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await runMigrations(db);
  process.stdout.write('Re-applied migrations.\n');
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const confirmed = process.env.DAFTARI_RESET_CONFIRM === 'yes';

  if (!usesPostgres()) {
    await resetSqlite();
    process.stdout.write(`Data directory: ${resolveDataDir()}\n`);
    closeDatabase();
    return;
  }

  if (!force || !confirmed) {
    process.stderr.write(
      'Refusing to reset PostgreSQL. This deletes all data.\n' +
        'Re-run with both --force and DAFTARI_RESET_CONFIRM=yes to proceed.\n',
    );
    process.exitCode = 1;
    return;
  }

  await resetPostgres(getDatabase());
  closeDatabase();
}

await main();
