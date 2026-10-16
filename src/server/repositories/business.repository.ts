/**
 * Business, membership, session and integration persistence.
 *
 * Every read and write is scoped by `business_id`; cross-tenant identifiers
 * simply do not match, which the service layer reports as "not found" to avoid
 * disclosing another business's records.
 */

import { all, get, run, type Db } from '@/server/db/client';
import { newId, nowIso, toJson, fromJson, fromSqlBool } from '@/server/db/ids';
import type { IntegrationStatus, Role } from '@/server/domain/types';
import type { BusinessFeatures, TenantScope } from '@/server/business-context/context';

export type UserRow = {
  id: string;
  provider_subject: string;
  display_name: string;
  contact_reference: string | null;
  status: 'active' | 'disabled';
  locale: string;
  /** Credential sign-in only. NULL for users owned by an identity provider. */
  email: string | null;
  /** Self-describing scrypt digest; see `@/server/auth/password`. Never logged. */
  password_hash: string | null;
  created_at: string;
  updated_at: string;
};

export type BusinessRow = {
  id: string;
  name: string;
  business_type: string;
  location: string | null;
  timezone: string;
  currency: string;
  locale: string;
  status: 'active' | 'suspended';
  features_json: string;
  onboarding_step: string | null;
  retention_audio_days: number;
  analytics_opt_in: number;
  created_at: string;
  updated_at: string;
};

export type MembershipRow = {
  id: string;
  business_id: string;
  user_id: string;
  role: Role;
  status: 'invited' | 'active' | 'revoked';
  permission_overrides_json: string;
  invited_by_user_id: string | null;
  invited_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  id: string;
  user_id: string;
  active_business_id: string | null;
  user_agent_hash: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

export type IntegrationRow = {
  id: string;
  business_id: string;
  provider: string;
  external_account_ref: string | null;
  status: IntegrationStatus;
  scopes_json: string;
  consent_given_at: string | null;
  consent_revoked_at: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  last_webhook_at: string | null;
  health_json: string;
  created_at: string;
  updated_at: string;
};

/* ------------------------------------------------------------------ users */

export async function findUserById(db: Db, userId: string): Promise<UserRow | undefined> {
  return await get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', [userId]);
}

/** Looks up the identity provider subject, the key a managed OIDC login uses. */
export async function findUserByProviderSubject(db: Db, providerSubject: string): Promise<UserRow | undefined> {
  return await get<UserRow>(db, 'SELECT * FROM users WHERE provider_subject = ?', [providerSubject]);
}

/**
 * Looks up a credential sign-in account by normalized email.
 *
 * Callers must pass an already-normalized address (see `normalizeEmail` in the
 * auth routes) so a row written by one casing can never be missed by a lookup
 * in another.
 */
export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  return await get<UserRow>(db, 'SELECT * FROM users WHERE email = ?', [email]);
}

/**
 * True when the address is already registered.
 *
 * Used by sign-up to report "that address is already in use" before the account
 * is created. Sign-in deliberately does not use this: it verifies the password
 * unconditionally so an attacker cannot enumerate accounts.
 */
export async function emailInUse(db: Db, email: string): Promise<boolean> {
  const row = await get<{ id: string }>(db, 'SELECT id FROM users WHERE email = ?', [email]);
  return row !== undefined;
}

export async function listUsers(db: Db): Promise<UserRow[]> {
  return await all<UserRow>(db, 'SELECT * FROM users ORDER BY display_name');
}

export async function createUser(
  db: Db,
  input: {
    id?: string;
    providerSubject: string;
    displayName: string;
    contactReference?: string;
    locale?: string;
    email?: string;
    passwordHash?: string;
  },
): Promise<UserRow> {
  const id = input.id ?? newId('usr');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO users (id, provider_subject, display_name, contact_reference, status, locale, email, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    [
      id,
      input.providerSubject,
      input.displayName,
      input.contactReference ?? null,
      input.locale ?? 'en',
      input.email ?? null,
      input.passwordHash ?? null,
      timestamp,
      timestamp,
    ],
  );
  return await findUserById(db, id) as UserRow;
}

export async function updateUserLocale(db: Db, userId: string, locale: string): Promise<void> {
  await run(db, 'UPDATE users SET locale = ?, updated_at = ? WHERE id = ?', [locale, nowIso(), userId]);
}

/* ------------------------------------------------------------- businesses */

export async function findBusinessById(db: Db, businessId: string): Promise<BusinessRow | undefined> {
  return await get<BusinessRow>(db, 'SELECT * FROM businesses WHERE id = ?', [businessId]);
}

export async function createBusiness(
  db: Db,
  input: {
    name: string;
    businessType: string;
    location?: string | null;
    timezone?: string;
    currency?: string;
    locale?: string;
    features?: Partial<BusinessFeatures>;
    onboardingStep?: string | null;
  },
): Promise<BusinessRow> {
  const id = newId('biz');
  const timestamp = nowIso();
  const features: BusinessFeatures = {
    inventory: false,
    manualEntries: true,
    deni: true,
    exports: true,
    ...input.features,
  };
  await run(
    db,
    `INSERT INTO businesses (
       id, name, business_type, location, timezone, currency, locale, status,
       features_json, onboarding_step, retention_audio_days, analytics_opt_in, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 30, 0, ?, ?)`,
    [
      id,
      input.name,
      input.businessType,
      input.location ?? null,
      input.timezone ?? 'Africa/Dar_es_Salaam',
      input.currency ?? 'TZS',
      input.locale ?? 'en',
      toJson(features),
      input.onboardingStep ?? null,
      timestamp,
      timestamp,
    ],
  );
  return await findBusinessById(db, id) as BusinessRow;
}

export async function updateBusinessFields(db: Db, businessId: string, fields: Record<string, unknown>): Promise<void> {
  const allowed = new Set([
    'name',
    'business_type',
    'location',
    'timezone',
    'currency',
    'locale',
    'features_json',
    'onboarding_step',
    'retention_audio_days',
    'analytics_opt_in',
  ]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  await run(db, `UPDATE businesses SET ${assignments}, updated_at = ? WHERE id = ?`, [
    ...entries.map(([, value]) => value),
    nowIso(),
    businessId,
  ]);
}

export async function setOnboardingStep(db: Db, businessId: string, step: string | null): Promise<void> {
  await run(db, 'UPDATE businesses SET onboarding_step = ?, updated_at = ? WHERE id = ?', [
    step,
    nowIso(),
    businessId,
  ]);
}

export function businessFeatures(row: BusinessRow): BusinessFeatures {
  return fromJson<BusinessFeatures>(row.features_json, {
    inventory: false,
    manualEntries: true,
    deni: true,
    exports: true,
  });
}

/* ----------------------------------------------------------- memberships */

export async function findMembership(
  db: Db,
  scope: TenantScope,
  userId: string,
): Promise<MembershipRow | undefined> {
  return await get<MembershipRow>(
    db,
    `SELECT * FROM business_memberships
     WHERE business_id = ? AND user_id = ? AND status IN ('invited', 'active')`,
    [scope.businessId, userId],
  );
}

export async function listMemberships(db: Db, scope: TenantScope): Promise<(MembershipRow & { display_name: string })[]> {
  return await all<MembershipRow & { display_name: string }>(
    db,
    `SELECT m.*, u.display_name
     FROM business_memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.business_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.display_name`,
    [scope.businessId],
  );
}

export type MembershipWithRole = { role: Role; membership_status: string };

export async function listBusinessesForUser(db: Db, userId: string): Promise<(BusinessRow & MembershipWithRole)[]> {
  return await all<BusinessRow & MembershipWithRole>(
    db,
    `SELECT b.*, m.role AS role, m.status AS membership_status
     FROM businesses b
     JOIN business_memberships m ON m.business_id = b.id
     WHERE m.user_id = ? AND m.status IN ('invited', 'active') AND b.status = 'active'
     ORDER BY b.name`,
    [userId],
  );
}

export async function createMembership(
  db: Db,
  input: {
    businessId: string;
    userId: string;
    role: Role;
    status?: 'invited' | 'active';
    invitedByUserId?: string | null;
  },
): Promise<MembershipRow> {
  const id = newId('mem');
  const timestamp = nowIso();
  const status = input.status ?? 'active';
  await run(
    db,
    `INSERT INTO business_memberships (
       id, business_id, user_id, role, status, permission_overrides_json,
       invited_by_user_id, invited_at, accepted_at, revoked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      input.businessId,
      input.userId,
      input.role,
      status,
      input.invitedByUserId ?? null,
      timestamp,
      status === 'active' ? timestamp : null,
      timestamp,
      timestamp,
    ],
  );
  return await get<MembershipRow>(db, 'SELECT * FROM business_memberships WHERE id = ?', [id]) as MembershipRow;
}

export async function updateMembershipRole(db: Db, membershipId: string, role: Role): Promise<void> {
  await run(db, 'UPDATE business_memberships SET role = ?, updated_at = ? WHERE id = ?', [
    role,
    nowIso(),
    membershipId,
  ]);
}

export async function revokeMembership(db: Db, membershipId: string): Promise<void> {
  const timestamp = nowIso();
  await run(
    db,
    `UPDATE business_memberships
     SET status = 'revoked', revoked_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('invited', 'active')`,
    [timestamp, timestamp, membershipId],
  );
}

export async function countActiveOwners(db: Db, businessId: string): Promise<number> {
  const row = await get<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM business_memberships
     WHERE business_id = ? AND role = 'owner' AND status = 'active'`,
    [businessId],
  );
  return row?.count ?? 0;
}

/* -------------------------------------------------------------- sessions */

export async function createSession(
  db: Db,
  input: {
    userId: string;
    activeBusinessId: string | null;
    expiresAt: string;
    tokenHash: string;
    userAgentHash?: string | null;
  },
): Promise<SessionRow> {
  const id = newId('ses');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO sessions (id, user_id, active_business_id, token_hash, user_agent_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      input.userId,
      input.activeBusinessId,
      input.tokenHash,
      input.userAgentHash ?? null,
      timestamp,
      input.expiresAt,
    ],
  );
  return await get<SessionRow>(db, 'SELECT * FROM sessions WHERE id = ?', [id]) as SessionRow;
}

export async function findActiveSession(
  db: Db,
  tokenHash: string,
  nowIsoValue = nowIso(),
): Promise<SessionRow | undefined> {
  return await get<SessionRow>(
    db,
    `SELECT * FROM sessions
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    [tokenHash, nowIsoValue],
  );
}

export async function setSessionActiveBusiness(db: Db, sessionId: string, businessId: string): Promise<void> {
  await run(db, 'UPDATE sessions SET active_business_id = ? WHERE id = ?', [businessId, sessionId]);
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
    nowIso(),
    sessionId,
  ]);
}

/* ----------------------------------------------------------- integrations */

export async function findIntegrationByProviderAccount(
  db: Db,
  provider: string,
  externalAccountRef: string,
): Promise<IntegrationRow | undefined> {
  return await get<IntegrationRow>(
    db,
    'SELECT * FROM integrations WHERE provider = ? AND external_account_ref = ?',
    [provider, externalAccountRef],
  );
}

export async function findIntegrationById(db: Db, scope: TenantScope, integrationId: string): Promise<IntegrationRow | undefined> {
  return await get<IntegrationRow>(db, 'SELECT * FROM integrations WHERE id = ? AND business_id = ?', [
    integrationId,
    scope.businessId,
  ]);
}

export async function listIntegrations(db: Db, scope: TenantScope): Promise<IntegrationRow[]> {
  return await all<IntegrationRow>(db, 'SELECT * FROM integrations WHERE business_id = ? ORDER BY provider', [
    scope.businessId,
  ]);
}

export async function upsertIntegration(
  db: Db,
  input: {
    businessId: string;
    provider: string;
    externalAccountRef: string;
    status: IntegrationStatus;
    scopes: string[];
    consentGivenAt?: string | null;
  },
): Promise<IntegrationRow> {
  const existing = await findIntegrationByProviderAccount(db, input.provider, input.externalAccountRef);
  const timestamp = nowIso();
  if (existing) {
    await run(
      db,
      `UPDATE integrations
       SET status = ?, scopes_json = ?, consent_given_at = COALESCE(?, consent_given_at),
           connected_at = COALESCE(connected_at, ?), disconnected_at = NULL, updated_at = ?
       WHERE id = ?`,
      [
        input.status,
        toJson(input.scopes),
        input.consentGivenAt ?? null,
        timestamp,
        timestamp,
        existing.id,
      ],
    );
    return await findIntegrationById(db, { businessId: existing.business_id }, existing.id) as IntegrationRow;
  }
  const id = newId('int');
  await run(
    db,
    `INSERT INTO integrations (
       id, business_id, provider, external_account_ref, status, scopes_json,
       consent_given_at, connected_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.businessId,
      input.provider,
      input.externalAccountRef,
      input.status,
      toJson(input.scopes),
      input.consentGivenAt ?? timestamp,
      timestamp,
      timestamp,
      timestamp,
    ],
  );
  return await findIntegrationById(db, { businessId: input.businessId }, id) as IntegrationRow;
}

export async function updateIntegrationStatus(db: Db, integrationId: string, status: IntegrationStatus): Promise<void> {
  const timestamp = nowIso();
  await run(
    db,
    `UPDATE integrations
     SET status = ?,
         connected_at = CASE WHEN ? = 'connected' THEN COALESCE(connected_at, ?) ELSE connected_at END,
         disconnected_at = CASE WHEN ? = 'disconnected' THEN ? ELSE disconnected_at END,
         updated_at = ?
     WHERE id = ?`,
    [status, status, timestamp, status, timestamp, timestamp, integrationId],
  );
}

export async function recordIntegrationWebhook(db: Db, integrationId: string, receivedAt = nowIso()): Promise<void> {
  await run(db, 'UPDATE integrations SET last_webhook_at = ?, updated_at = ? WHERE id = ?', [
    receivedAt,
    receivedAt,
    integrationId,
  ]);
}

export async function updateIntegrationConsent(
  db: Db,
  integrationId: string,
  consentGiven: boolean,
): Promise<void> {
  const timestamp = nowIso();
  await run(
    db,
    `UPDATE integrations
     SET consent_given_at = CASE WHEN ? THEN COALESCE(consent_given_at, ?) ELSE consent_given_at END,
         consent_revoked_at = CASE WHEN ? THEN ? ELSE consent_revoked_at END,
         updated_at = ?
     WHERE id = ?`,
    [consentGiven ? 1 : 0, timestamp, consentGiven ? 0 : 1, timestamp, timestamp, integrationId],
  );
}

export function integrationScopes(row: IntegrationRow): string[] {
  return fromJson<string[]>(row.scopes_json, []);
}

export function integrationHealth(row: IntegrationRow): Record<string, string | number | boolean> {
  return fromJson<Record<string, string | number | boolean>>(row.health_json, {});
}

export async function setIntegrationHealth(
  db: Db,
  integrationId: string,
  health: Record<string, string | number | boolean>,
): Promise<void> {
  await run(db, 'UPDATE integrations SET health_json = ?, updated_at = ? WHERE id = ?', [
    toJson(health),
    nowIso(),
    integrationId,
  ]);
}

export function analyticsOptIn(row: BusinessRow): boolean {
  return fromSqlBool(row.analytics_opt_in);
}