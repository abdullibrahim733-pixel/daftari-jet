/**
 * Liveness and readiness.
 *
 * Deliberately cheap: it reports the schema version so a deployment can tell a
 * migrated database from a stale one without touching any business data.
 */

import { getDatabase } from '@/server/db/client';
import { currentMigration } from '@/server/db/migrations';
import { ok, route } from '@/server/http/route';

export const GET = route(async () => {
  const db = getDatabase();
  return ok({
    status: 'ok',
    schemaVersion: await currentMigration(db) ?? null,
    now: new Date().toISOString(),
  });
});
