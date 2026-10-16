/**
 * Session token handling.
 *
 * The cookie holds an opaque bearer token; the database stores only its
 * SHA-256. These tests pin that contract, because the failure mode it
 * prevents is silent: a cookie that never resolves just looks like a
 * user who is always logged out.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './helpers/fixture';
import { hashSessionToken, issueSession, newOpaqueSessionToken } from '@/server/auth/session-store';
import { findActiveSession, findUserById, revokeSession } from '@/server/repositories/business.repository';
import { all } from '@/server/db/client';

describe('session tokens', () => {
  it('resolves a session from the issued token', async () => {
    const { db, userId } = await createFixture();
    const issued = await issueSession(db, { userId, activeBusinessId: null });

    const session = await findActiveSession(db, hashSessionToken(issued.token));

    assert.ok(session, 'the issued token must resolve to a session');
    assert.equal(session.user_id, userId);
    assert.equal(session.revoked_at, null);
  });

  it('does not accept the session row id as the cookie value', async () => {
    const { db, userId } = await createFixture();
    const issued = await issueSession(db, { userId, activeBusinessId: null });

    assert.notEqual(issued.token, issued.sessionId);
    assert.equal(await findActiveSession(db, hashSessionToken(issued.sessionId)), undefined);
  });

  it('stores only the token hash, never the raw token', async () => {
    const { db, userId } = await createFixture();
    const issued = await issueSession(db, { userId, activeBusinessId: null });

    const rows = await all<Record<string, unknown>>(db, 'SELECT token_hash FROM sessions');
    const hashes = rows.map((row) => String(row.token_hash));

    assert.ok(!hashes.includes(issued.token), 'the raw token must not be stored');
    assert.ok(hashes.includes(hashSessionToken(issued.token)));
  });

  it('rejects an unrelated token', async () => {
    const { db, userId } = await createFixture();
    await issueSession(db, { userId, activeBusinessId: null });

    assert.equal(await findActiveSession(db, hashSessionToken(newOpaqueSessionToken())), undefined);
  });

  it('stops resolving after revocation', async () => {
    const { db, userId } = await createFixture();
    const issued = await issueSession(db, { userId, activeBusinessId: null });
    const tokenHash = hashSessionToken(issued.token);
    assert.ok(await findActiveSession(db, tokenHash));

    await revokeSession(db, issued.sessionId);

    assert.equal(await findActiveSession(db, tokenHash), undefined);
  });

  it('stops resolving once the session has expired', async () => {
    const { db, userId } = await createFixture();
    const issued = await issueSession(db, { userId, activeBusinessId: null });
    const tokenHash = hashSessionToken(issued.token);

    // One second past the 14-day lifetime.
    const afterExpiry = new Date(Date.now() + 15 * 86_400_000).toISOString();
    assert.equal(await findActiveSession(db, tokenHash, afterExpiry), undefined);
  });

  it('issues a distinct token every time', async () => {
    const { db, userId } = await createFixture();
    const first = await issueSession(db, { userId, activeBusinessId: null });
    const second = await issueSession(db, { userId, activeBusinessId: null });

    assert.notEqual(first.token, second.token);
    assert.notEqual(first.sessionId, second.sessionId);
    assert.ok(await findUserById(db, userId));
  });
});
