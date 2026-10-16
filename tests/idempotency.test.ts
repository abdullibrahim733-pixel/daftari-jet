/**
 * Idempotent request handling.
 *
 * The point of the helper is that the write and the replayable response share
 * one transaction. These tests assert both halves of that: a retry replays
 * instead of writing twice, and a failed write leaves no key behind to block
 * the caller's retry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './helpers/fixture';
import { exec, get } from '@/server/db/client';
import { parseIdempotencyKey, requestHash, withIdempotency } from '@/server/services/idempotency';
import {
  beginIdempotentRequest,
  findIdempotencyRecord,
} from '@/server/repositories/platform.repository';
import { ERROR_CODES } from '@/lib/errors';

describe('idempotency keys', () => {
  it('rejects malformed keys', () => {
    assert.equal(parseIdempotencyKey(null, 'confirm'), null);
    assert.equal(parseIdempotencyKey('   ', 'confirm'), null);
    assert.equal(parseIdempotencyKey('has spaces', 'confirm'), null);
    assert.equal(parseIdempotencyKey('x'.repeat(129), 'confirm'), null);
    assert.deepEqual(parseIdempotencyKey(' abc-123 ', 'confirm'), { scope: 'confirm', key: 'abc-123' });
  });
});

describe('withIdempotency', () => {
  it('executes once and replays the stored response on retry', async () => {
    const { db } = await createFixture();
    const key = { scope: 'confirm', key: 'k1' };
    let calls = 0;

    const first = await withIdempotency(db, key, { amountMinor: 500 }, async () => {
      calls += 1;
      return { status: 201, body: { recordId: 'rec_1' } };
    });
    assert.equal(first.kind, 'executed');

    const retry = await withIdempotency(db, key, { amountMinor: 500 }, async () => {
      calls += 1;
      return { status: 201, body: { recordId: 'rec_2' } };
    });

    assert.equal(calls, 1, 'the work must run only once');
    assert.equal(retry.kind, 'replayed');
    if (retry.kind === 'replayed') {
      assert.equal(retry.status, 201);
      assert.deepEqual(retry.body, { recordId: 'rec_1' });
    }
  });

  it('rejects a key reused with a different body', async () => {
    const { db } = await createFixture();
    const key = { scope: 'confirm', key: 'k2' };
    await withIdempotency(db, key, { amountMinor: 500 }, async () => ({ status: 201, body: { ok: true } }));

    await assert.rejects(
      async () => await withIdempotency(db, key, { amountMinor: 900 }, async () => ({ status: 201, body: { ok: true } })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
        return true;
      },
    );
  });

  it('rolls back the key when the work throws, so the retry can proceed', async () => {
    const { db } = await createFixture();
    const key = { scope: 'confirm', key: 'k3' };

await assert.rejects(
      async () =>
        await withIdempotency(db, key, { amountMinor: 500 }, async () => {
          throw new Error('ledger write failed');
        }),
      /ledger write failed/,
    );

    // No half-open key may survive the failure.
    assert.equal(await findIdempotencyRecord(db, 'confirm', 'k3'), undefined);

    const retry = await withIdempotency(db, key, { amountMinor: 500 }, async () => ({
      status: 201,
      body: { ok: true },
    }));
    assert.equal(retry.kind, 'executed');
  });

  it('rolls back the work itself when it throws', async () => {
    const { db } = await createFixture();
    const key = { scope: 'confirm', key: 'k4' };
    await exec(db, 'CREATE TABLE probe (id TEXT PRIMARY KEY)');

    await assert.rejects(async () =>
      await withIdempotency(db, key, {}, async () => {
        await exec(db, "INSERT INTO probe (id) VALUES ('a')");
        throw new Error('boom');
      }),
    );

    const remaining = (await get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM probe')) as { count: number };
    assert.equal(remaining.count, 0, 'the insert must be rolled back with the key');
  });

  it('reports a concurrently claimed key as in flight instead of repeating the work', async () => {
    const { db } = await createFixture();
    const key = { scope: 'confirm', key: 'k5' };
    const body = { amountMinor: 1 };
    let calls = 0;

    // Another request claimed this key and has not finished yet.
    await beginIdempotentRequest(db, key.scope, key.key, requestHash(body));

    const result = await withIdempotency(db, key, body, async () => {
      calls += 1;
      return { status: 201, body: {} };
    });

    assert.equal(calls, 0, 'the work must not run twice for one key');
    assert.equal(result.kind, 'in_progress');
  });

  it('still conflicts when an in-flight key carries a different body', async () => {
    const { db } = await createFixture();
    const key = { scope: 'confirm', key: 'k6' };
    await beginIdempotentRequest(db, key.scope, key.key, requestHash({ amountMinor: 1 }));

    await assert.rejects(
      async () => await withIdempotency(db, key, { amountMinor: 2 }, async () => ({ status: 201, body: {} })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
        return true;
      },
    );
  });
});
