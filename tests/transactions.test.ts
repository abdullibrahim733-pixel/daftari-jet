/**
 * Nested transactions on the local SQLite backend.
 *
 * Confirming a proposal runs its own transaction inside the idempotency
 * wrapper's transaction. SQLite has no nested BEGIN, so the inner call has to
 * become a savepoint; before that it failed with "cannot start a transaction
 * within a transaction" and every confirmation returned a 500.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exec, get, run, withTransaction } from '@/server/db/client';
import { createFixture } from './helpers/fixture';

async function count(db: Awaited<ReturnType<typeof createFixture>>['db']): Promise<number> {
  const row = await get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM tx_probe');
  return row?.n ?? 0;
}

describe('withTransaction nesting (sqlite)', () => {
  it('commits inner work together with the outer transaction', async () => {
    const { db } = await createFixture();
    await exec(db, 'CREATE TABLE tx_probe (id INTEGER PRIMARY KEY)');
    await withTransaction(async () => {
      await run(db, 'INSERT INTO tx_probe (id) VALUES (1)');
      await withTransaction(async () => {
        await run(db, 'INSERT INTO tx_probe (id) VALUES (2)');
      }, db);
    }, db);
    assert.equal(await count(db), 2);
  });

  it('rolls back only the inner work when the inner transaction fails', async () => {
    const { db } = await createFixture();
    await exec(db, 'CREATE TABLE tx_probe (id INTEGER PRIMARY KEY)');
    await withTransaction(async () => {
      await run(db, 'INSERT INTO tx_probe (id) VALUES (1)');
      await assert.rejects(
        withTransaction(async () => {
          await run(db, 'INSERT INTO tx_probe (id) VALUES (2)');
          throw new Error('inner failure');
        }, db),
        /inner failure/,
      );
    }, db);
    assert.equal(await count(db), 1);
  });
});
