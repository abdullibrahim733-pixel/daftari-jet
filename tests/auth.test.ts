/**
 * Credential authentication.
 *
 * These tests exist mostly to pin the regression that motivated them: the live
 * deployment ran with `DAFTARI_ALLOW_DEV_LOGIN=1`, which turned
 * `POST /api/v1/dev/login` into an unauthenticated account-creation endpoint on
 * a financial system — including minting a business with `owner` role. The
 * `dev sign-in is never available in production` case below is the guard for
 * that, and it must never be relaxed without replacing it with a real identity
 * provider.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
} from '@/server/auth/password';
import { devLoginEnabled } from '@/server/auth/session-store';
import { consume, reset, resetAll } from '@/server/auth/rate-limit';
import { safeNextPath } from '@/lib/redirect';
import { createFixture } from './helpers/fixture';
import {
  createBusiness,
  createMembership,
  createUser,
  emailInUse,
  findUserByEmail,
} from '@/server/repositories/business.repository';

const VALID_PASSWORD = 'CorrectHorse42';

describe('password hashing', () => {
  it('round-trips a password through hash and verify', async () => {
    const stored = await hashPassword(VALID_PASSWORD);

    assert.equal(await verifyPassword(VALID_PASSWORD, stored), true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword(VALID_PASSWORD);

    assert.equal(await verifyPassword('WrongHorse42', stored), false);
  });

  it('salts, so the same password never produces the same digest twice', async () => {
    const first = await hashPassword(VALID_PASSWORD);
    const second = await hashPassword(VALID_PASSWORD);

    assert.notEqual(first, second);
  });

  it('never stores the password in the digest', async () => {
    const stored = await hashPassword(VALID_PASSWORD);

    assert.ok(!stored.includes(VALID_PASSWORD));
  });

  it('denies access instead of throwing when the stored hash is missing or corrupt', async () => {
    assert.equal(await verifyPassword(VALID_PASSWORD, null), false);
    assert.equal(await verifyPassword(VALID_PASSWORD, undefined), false);
    assert.equal(await verifyPassword(VALID_PASSWORD, ''), false);
    assert.equal(await verifyPassword(VALID_PASSWORD, 'not-a-hash'), false);
    assert.equal(await verifyPassword(VALID_PASSWORD, 'scrypt$a$b$c$d$e$f'), false);
  });

  it('refuses stored parameters that would ask for unbounded memory', async () => {
    // N far above any sane value must be rejected before scrypt is invoked.
    assert.equal(await verifyPassword(VALID_PASSWORD, 'scrypt$99999999$8$1$64$c2FsdA==$aGFzaA=='), false);
  });
});

describe('password policy', () => {
  it('accepts a password that meets the policy', () => {
    assert.equal(checkPasswordPolicy(VALID_PASSWORD).ok, true);
  });

  it('rejects a password under the minimum length', () => {
    assert.equal(checkPasswordPolicy('Ab1').ok, false);
  });

  it('rejects a password with no digits', () => {
    const result = checkPasswordPolicy('LongEnoughButNoDigits');
    assert.equal(result.ok, false);
  });

  it('rejects a password with no uppercase letter', () => {
    assert.equal(checkPasswordPolicy('longenoughbutnouppercase1').ok, false);
  });

  it('advertises the same minimum the check enforces', () => {
    assert.equal(checkPasswordPolicy('a'.repeat(MIN_PASSWORD_LENGTH - 1)).ok, false);
    assert.equal(checkPasswordPolicy('Aa1' + 'a'.repeat(MIN_PASSWORD_LENGTH - 3)).ok, true);
  });
});

describe('dev sign-in availability', () => {
  // `process.env.NODE_ENV` is declared read-only by the ambient Node types, so
  // the tests mutate through an explicit mutable view and restore afterwards.
  const env = process.env as Record<string, string | undefined>;
  const originalNodeEnv = env.NODE_ENV;
  const originalFlag = env.DAFTARI_ALLOW_DEV_LOGIN;

  function restore() {
    if (originalNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalNodeEnv;
    if (originalFlag === undefined) delete env.DAFTARI_ALLOW_DEV_LOGIN;
    else env.DAFTARI_ALLOW_DEV_LOGIN = originalFlag;
  }

  it('is never available in production, even when the flag is explicitly 1', () => {
    // This is the exact condition that was live on the deployment.
    env.NODE_ENV = 'production';
    env.DAFTARI_ALLOW_DEV_LOGIN = '1';

    try {
      assert.equal(devLoginEnabled(), false);
    } finally {
      restore();
    }
  });

  it('stays available in development unless explicitly turned off', () => {
    env.NODE_ENV = 'development';

    try {
      env.DAFTARI_ALLOW_DEV_LOGIN = '1';
      assert.equal(devLoginEnabled(), true);
      env.DAFTARI_ALLOW_DEV_LOGIN = '0';
      assert.equal(devLoginEnabled(), false);
    } finally {
      restore();
    }
  });
});

describe('auth rate limiting', () => {
  beforeEach(() => resetAll());

  it('allows attempts up to the limit and refuses the next one', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(consume('email:a@b.co', 3).allowed, true);
    }

    const refused = consume('email:a@b.co', 3);
    assert.equal(refused.allowed, false);
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterSeconds > 0);
  });

  it('keys limits per identity, so one account cannot lock another out', () => {
    for (let attempt = 0; attempt < 2; attempt += 1) consume('email:a@b.co', 2);

    assert.equal(consume('email:a@b.co', 2).allowed, false);
    assert.equal(consume('email:other@b.co', 2).allowed, true);
  });

  it('clears the budget after a successful sign-in', () => {
    for (let attempt = 0; attempt < 2; attempt += 1) consume('email:a@b.co', 2);
    assert.equal(consume('email:a@b.co', 2).allowed, false);

    reset('email:a@b.co');

    assert.equal(consume('email:a@b.co', 2).allowed, true);
  });
});

describe('credential accounts against a migrated database', () => {
  it('stores an account that sign-in can find and verify', async () => {
    const { db } = await createFixture();

    const passwordHash = await hashPassword(VALID_PASSWORD);
    await createUser(db, {
      providerSubject: 'email:amina@jumagrocery.co.tz',
      displayName: 'Amina Juma',
      email: 'amina@jumagrocery.co.tz',
      passwordHash,
    });

    const found = await findUserByEmail(db, 'amina@jumagrocery.co.tz');
    assert.ok(found, 'the account must be findable by email');
    assert.equal(found.display_name, 'Amina Juma');
    assert.equal(await verifyPassword(VALID_PASSWORD, found.password_hash), true);
    assert.equal(await verifyPassword('WrongHorse42', found.password_hash), false);
  });

  it('never stores the password itself', async () => {
    const { db } = await createFixture();

    const passwordHash = await hashPassword(VALID_PASSWORD);
    await createUser(db, {
      providerSubject: 'email:amina@jumagrocery.co.tz',
      displayName: 'Amina Juma',
      email: 'amina@jumagrocery.co.tz',
      passwordHash,
    });

    const found = await findUserByEmail(db, 'amina@jumagrocery.co.tz');
    assert.ok(!String(found?.password_hash).includes(VALID_PASSWORD));
  });

  it('reports a taken address so sign-up can refuse the duplicate', async () => {
    const { db } = await createFixture();

    assert.equal(await emailInUse(db, 'amina@jumagrocery.co.tz'), false);
    await createUser(db, {
      providerSubject: 'email:amina@jumagrocery.co.tz',
      displayName: 'Amina Juma',
      email: 'amina@jumagrocery.co.tz',
      passwordHash: await hashPassword(VALID_PASSWORD),
    });
    assert.equal(await emailInUse(db, 'amina@jumagrocery.co.tz'), true);
  });

  it('builds the first business and an owner membership for a new account', async () => {
    const { db } = await createFixture();

    const user = await createUser(db, {
      providerSubject: 'email:amina@jumagrocery.co.tz',
      displayName: 'Amina Juma',
      email: 'amina@jumagrocery.co.tz',
      passwordHash: await hashPassword(VALID_PASSWORD),
    });
    const business = await createBusiness(db, { name: 'Juma Grocery', businessType: 'shop' });
    const membership = await createMembership(db, {
      businessId: business.id,
      userId: user.id,
      role: 'owner',
    });

    assert.equal(membership.role, 'owner');
    assert.equal(membership.status, 'active');
    assert.equal(business.timezone, 'Africa/Dar_es_Salaam');
    assert.equal(business.currency, 'TZS');
  });

  it('leaves provider-only accounts without a password, so they cannot sign in with one', async () => {
    const { db, userId } = await createFixture();

    const providerOnly = await createUser(db, {
      providerSubject: 'oidc|abc123',
      displayName: 'Provider User',
    });

    assert.equal(providerOnly.password_hash, null);
    assert.equal(await verifyPassword(VALID_PASSWORD, providerOnly.password_hash), false);
    // The fixture's own user is unaffected by the additive migration.
    const existing = await findUserByEmail(db, '');
    assert.equal(existing, undefined);
    assert.ok(userId);
  });
});

describe('post sign-in redirect', () => {
  it('follows a normal same-origin path', () => {
    assert.equal(safeNextPath('/review'), '/review');
    assert.equal(safeNextPath('/records/rec_1/edit'), '/records/rec_1/edit');
  });

  it('refuses to leave the origin', () => {
    assert.equal(safeNextPath('https://evil.example/steal'), '/');
    assert.equal(safeNextPath('//evil.example/steal'), '/');
    assert.equal(safeNextPath('/\\evil.example/steal'), '/');
    assert.equal(safeNextPath('/\\evil.example'), '/');
    assert.equal(safeNextPath('javascript:alert(1)'), '/');
  });

  it('refuses to bounce back to the sign-in screen', () => {
    assert.equal(safeNextPath('/login'), '/');
    assert.equal(safeNextPath('/login?next=/review'), '/');
  });

  it('falls back to the dashboard when absent', () => {
    assert.equal(safeNextPath(null), '/');
    assert.equal(safeNextPath(undefined), '/');
    assert.equal(safeNextPath(''), '/');
  });
});