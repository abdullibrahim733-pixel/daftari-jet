/**
 * Versioned schema migrations (architecture.md section 15).
 *
 * Rules applied here: additive, tenant-scoped indexes that begin with
 * `business_id`, database constraints for valid states and relationships, and
 * unique keys that make duplicate webhook delivery and double confirmation
 * impossible rather than unlikely.
 *
 * Booleans are stored as 0/1 and money as INTEGER minor units.
 */

import { all, exec, get, run, withTransaction, type Db } from './client';
import { nowIso } from './ids';

export type Migration = {
  id: string;
  sql: string;
  /**
   * Optional custom applier for migrations SQLite cannot run inside a
   * transaction, such as a table rebuild that has to toggle foreign keys.
   * `sql` is still recorded as the migration's checksum.
   */
  run?: (db: Db) => Promise<void>;
};

const INITIAL_SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  provider_subject TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  contact_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  locale TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  business_type TEXT NOT NULL,
  location TEXT,
  timezone TEXT NOT NULL DEFAULT 'Africa/Dar_es_Salaam',
  currency TEXT NOT NULL DEFAULT 'TZS',
  locale TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  features_json TEXT NOT NULL DEFAULT '{}',
  onboarding_step TEXT,
  retention_audio_days INTEGER NOT NULL DEFAULT 30,
  analytics_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE business_memberships (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'revoked')),
  permission_overrides_json TEXT NOT NULL DEFAULT '[]',
  invited_by_user_id TEXT REFERENCES users(id),
  invited_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_membership_active
  ON business_memberships (business_id, user_id)
  WHERE status IN ('invited', 'active');
CREATE INDEX ix_membership_user ON business_memberships (user_id, status);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  active_business_id TEXT REFERENCES businesses(id),
  user_agent_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX ix_sessions_user ON sessions (user_id, revoked_at);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  provider TEXT NOT NULL,
  external_account_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected', 'error', 'pending')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  consent_given_at TEXT,
  consent_revoked_at TEXT,
  connected_at TEXT,
  disconnected_at TEXT,
  last_webhook_at TEXT,
  health_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_integration_account
  ON integrations (provider, external_account_ref)
  WHERE external_account_ref IS NOT NULL;
CREATE INDEX ix_integration_business ON integrations (business_id, provider);

CREATE TABLE source_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  integration_id TEXT REFERENCES integrations(id),
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  sender_ref TEXT,
  received_at TEXT NOT NULL,
  provider_sent_at TEXT,
  dedupe_key TEXT NOT NULL,
  payload_redacted TEXT,
  status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'processed', 'failed', 'unsupported')),
  failure_code TEXT,
  processing_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_source_event_dedupe
  ON source_events (integration_id, provider_event_id);
CREATE INDEX ix_source_event_business ON source_events (business_id, received_at);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  source_event_id TEXT REFERENCES source_events(id),
  object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  duration_seconds REAL,
  checksum TEXT NOT NULL,
  encryption_metadata TEXT NOT NULL DEFAULT '{}',
  retention_deadline TEXT NOT NULL,
  deleted_at TEXT,
  access_classification TEXT NOT NULL DEFAULT 'highly_sensitive',
  created_at TEXT NOT NULL
);
CREATE INDEX ix_media_business ON media_assets (business_id, created_at);
CREATE INDEX ix_media_retention ON media_assets (retention_deadline, deleted_at);

CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  source_event_id TEXT NOT NULL REFERENCES source_events(id),
  media_asset_id TEXT REFERENCES media_assets(id),
  machine_text TEXT NOT NULL,
  corrected_text TEXT,
  corrected_by_user_id TEXT REFERENCES users(id),
  corrected_at TEXT,
  marked_unusable INTEGER NOT NULL DEFAULT 0,
  detected_language TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_version TEXT NOT NULL,
  quality_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'unusable')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_transcript_source ON transcripts (business_id, source_event_id);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  source_event_id TEXT NOT NULL REFERENCES source_events(id),
  transcript_id TEXT REFERENCES transcripts(id),
  record_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'processing', 'needs_review', 'needs_details', 'failed',
    'confirmed', 'rejected', 'duplicate'
  )),
  schema_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_version TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  validation_issues_json TEXT NOT NULL DEFAULT '[]',
  duplicate_candidates_json TEXT NOT NULL DEFAULT '[]',
  ambiguity_note TEXT,
  min_confidence REAL,
  version INTEGER NOT NULL DEFAULT 1,
  assigned_to_user_id TEXT REFERENCES users(id),
  decided_by_user_id TEXT REFERENCES users(id),
  decided_at TEXT,
  rejection_reason_code TEXT,
  rejection_note TEXT,
  confirmed_ledger_record_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_proposals_queue ON proposals (business_id, state, created_at);
CREATE INDEX ix_proposals_source ON proposals (business_id, source_event_id);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  display_name TEXT NOT NULL,
  contact_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_customers_business ON customers (business_id, display_name);

CREATE TABLE ledger_records (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  record_type TEXT NOT NULL CHECK (record_type IN (
    'sale', 'expense', 'debt_created', 'debt_payment', 'stock_movement', 'note'
  )),
  occurred_at TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor INTEGER,
  description TEXT,
  customer_id TEXT REFERENCES customers(id),
  payee_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('posted', 'voided', 'reversed')),
  origin TEXT NOT NULL CHECK (origin IN ('whatsapp', 'manual', 'import')),
  source_event_id TEXT,
  proposal_id TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  confirmed_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_record_id TEXT,
  reverses_record_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (record_type = 'note' AND amount_minor IS NULL)
    OR (record_type <> 'note' AND amount_minor IS NOT NULL)
  )
);
CREATE INDEX ix_ledger_period ON ledger_records (business_id, occurred_at);
CREATE INDEX ix_ledger_type ON ledger_records (business_id, record_type, status);
CREATE INDEX ix_ledger_customer ON ledger_records (business_id, customer_id);
CREATE INDEX ix_ledger_proposal ON ledger_records (proposal_id);

-- Versioned history: financial history is corrected, never overwritten.
CREATE TABLE ledger_record_versions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  ledger_record_id TEXT NOT NULL REFERENCES ledger_records(id),
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('created', 'corrected', 'reversed', 'voided')),
  reason_code TEXT,
  reason_note TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ledger_version
  ON ledger_record_versions (ledger_record_id, version);
CREATE INDEX ix_ledger_version_business ON ledger_record_versions (business_id, created_at);

CREATE TABLE sales (
  ledger_record_id TEXT PRIMARY KEY REFERENCES ledger_records(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('paid', 'unpaid', 'partial', 'unknown')),
  payment_method TEXT NOT NULL,
  external_reference TEXT,
  paid_at TEXT
);

CREATE TABLE expenses (
  ledger_record_id TEXT PRIMARY KEY REFERENCES ledger_records(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  category TEXT NOT NULL,
  vendor TEXT
);

CREATE TABLE debt_obligations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  ledger_record_id TEXT NOT NULL REFERENCES ledger_records(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  original_amount_minor INTEGER NOT NULL,
  due_date TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'settled', 'disputed', 'voided')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_obligation_customer ON debt_obligations (business_id, customer_id, state);

CREATE TABLE debt_payments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  ledger_record_id TEXT NOT NULL REFERENCES ledger_records(id),
  obligation_id TEXT REFERENCES debt_obligations(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  amount_minor INTEGER NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_debt_payment_customer ON debt_payments (business_id, customer_id, received_at);

CREATE TABLE line_items (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  ledger_record_id TEXT NOT NULL REFERENCES ledger_records(id),
  description TEXT NOT NULL,
  item_id TEXT,
  quantity_milli INTEGER NOT NULL,
  unit TEXT NOT NULL,
  unit_price_minor INTEGER,
  line_amount_minor INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_line_item_record ON line_items (business_id, ledger_record_id);

CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  sku TEXT,
  low_stock_threshold_milli INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_inventory_item_business ON inventory_items (business_id, name);

CREATE TABLE inventory_movements (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  ledger_record_id TEXT REFERENCES ledger_records(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('in', 'out', 'adjustment')),
  quantity_milli INTEGER NOT NULL,
  unit_cost_minor INTEGER,
  note TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_inventory_movement_item ON inventory_movements (business_id, item_id, occurred_at);

CREATE TABLE business_notes (
  ledger_record_id TEXT PRIMARY KEY REFERENCES ledger_records(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  note TEXT NOT NULL,
  privacy_classification TEXT NOT NULL DEFAULT 'confidential_business'
);

-- Audit history. The table is created before its append-only triggers, because
-- SQLite requires the target relation to exist first.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  event_time TEXT NOT NULL,
  request_id TEXT,
  reason_code TEXT,
  reason_note TEXT,
  before_json TEXT,
  after_json TEXT,
  source TEXT NOT NULL DEFAULT 'dashboard',
  integrity_hash TEXT NOT NULL,
  previous_hash TEXT
);
CREATE INDEX ix_audit_business ON audit_events (business_id, event_time);
CREATE INDEX ix_audit_entity ON audit_events (business_id, entity_type, entity_id);

-- Append-only enforcement (migration 0005) is installed later, because the
-- trigger DDL differs between SQLite and PostgreSQL.

-- Transactional outbox: downstream work is enqueued in the same transaction as
-- the state change that caused it.
CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  business_id TEXT,
  topic TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX ix_outbox_pending ON outbox_events (status, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  business_id TEXT,
  job_type TEXT NOT NULL CHECK (job_type IN (
    'acquire_media', 'transcribe_source', 'extract_proposal', 'validate_proposal',
    'refresh_summary', 'build_export', 'delete_expired_media', 'provider_health_check'
  )),
  entity_type TEXT,
  entity_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL,
  last_error_code TEXT,
  provider_correlation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX ux_jobs_idempotency ON jobs (idempotency_key);
CREATE INDEX ix_jobs_ready ON jobs (status, next_attempt_at);
CREATE INDEX ix_jobs_business ON jobs (business_id, job_type);

CREATE TABLE job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  provider_request_id TEXT
);
CREATE INDEX ix_job_runs_job ON job_runs (job_id, attempt);

CREATE TABLE idempotency_keys (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_idempotency_scope_key ON idempotency_keys (scope, idempotency_key);

CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'expired', 'failed')),
  format TEXT NOT NULL CHECK (format IN ('csv', 'xlsx')),
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  record_types_json TEXT NOT NULL DEFAULT '[]',
  object_key TEXT,
  row_count INTEGER,
  byte_size INTEGER,
  failure_code TEXT,
  requested_at TEXT NOT NULL,
  ready_at TEXT,
  expires_at TEXT,
  downloaded_at TEXT
);
CREATE INDEX ix_export_business ON export_jobs (business_id, requested_at);
`;

/**
 * Sales carry an optional category so "top categories" works for both
 * sides of the ledger. SQLite cannot ALTER TABLE ADD COLUMN with a
 * default, so the column is nullable and "uncategorised" is applied at
 * read time.
 */
const SALES_CATEGORY_SQL = `
ALTER TABLE sales ADD COLUMN category TEXT;
CREATE INDEX ix_sales_category ON sales (business_id, category);
`;

/**
 * The cookie carries an opaque bearer token, never the session row id, so a
 * leaked id (in a log line, an export or a URL) cannot be replayed as a
 * session. Only the SHA-256 of the token is stored, and lookup is by that
 * hash. Pre-existing rows keep a NULL hash and are unusable, which is the
 * safe direction: they simply require a fresh sign-in.
 */
const SESSION_TOKEN_HASH_SQL = `
ALTER TABLE sessions ADD COLUMN token_hash TEXT;
CREATE UNIQUE INDEX ix_sessions_token_hash ON sessions (token_hash);
`;

/**
 * A stock movement is not money: it moves a quantity, and its cost is optional.
 * The original CHECK required an amount for everything except notes, so a stock
 * movement could never be confirmed and the inventory feature could never be
 * used end to end.
 *
 * SQLite cannot drop a CHECK constraint with ALTER TABLE, so this is the
 * documented rebuild: create the corrected table, copy the rows across, swap the
 * names and recreate the indexes. Foreign keys are disabled for the swap because
 * they cannot be toggled inside a transaction, and the table is checked
 * afterwards so a rebuild can never leave dangling references behind.
 */
const LEDGER_AMOUNT_CHECK_SQL = [
  `CHECK (`,
  `  (record_type IN ('note', 'stock_movement') AND amount_minor IS NULL)`,
  `  OR (record_type NOT IN ('note', 'stock_movement') AND amount_minor IS NOT NULL)`,
  `)`,
].join('\n  ');

const LEDGER_REBUILD_SQL = `
CREATE TABLE ledger_records_rebuilt (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  record_type TEXT NOT NULL CHECK (record_type IN (
    'sale', 'expense', 'debt_created', 'debt_payment', 'stock_movement', 'note'
  )),
  occurred_at TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor INTEGER,
  description TEXT,
  customer_id TEXT REFERENCES customers(id),
  payee_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('posted', 'voided', 'reversed')),
  origin TEXT NOT NULL CHECK (origin IN ('whatsapp', 'manual', 'import')),
  source_event_id TEXT,
  proposal_id TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  confirmed_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_record_id TEXT,
  reverses_record_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ${LEDGER_AMOUNT_CHECK_SQL}
);
INSERT INTO ledger_records_rebuilt (
  id, business_id, record_type, occurred_at, currency, amount_minor, description,
  customer_id, payee_name, status, origin, source_event_id, proposal_id,
  created_by_user_id, confirmed_at, version, supersedes_record_id, reverses_record_id,
  created_at, updated_at
)
SELECT
  id, business_id, record_type, occurred_at, currency, amount_minor, description,
  customer_id, payee_name, status, origin, source_event_id, proposal_id,
  created_by_user_id, confirmed_at, version, supersedes_record_id, reverses_record_id,
  created_at, updated_at
FROM ledger_records;
DROP TABLE ledger_records;
ALTER TABLE ledger_records_rebuilt RENAME TO ledger_records;
CREATE INDEX ix_ledger_period ON ledger_records (business_id, occurred_at);
CREATE INDEX ix_ledger_type ON ledger_records (business_id, record_type, status);
CREATE INDEX ix_ledger_customer ON ledger_records (business_id, customer_id);
CREATE INDEX ix_ledger_proposal ON ledger_records (proposal_id);
`;

/** Applies the ledger rebuild outside a transaction, as SQLite requires. */
async function rebuildLedgerTable(db: Db): Promise<void> {
  if (db.kind === 'postgres') {
    await exec(
      db,
      `ALTER TABLE ledger_records DROP CONSTRAINT IF EXISTS ledger_records_amount_minor_check;
       ALTER TABLE ledger_records ADD CONSTRAINT ledger_records_amount_minor_check ${LEDGER_AMOUNT_CHECK_SQL}`,
    );
    return;
  }
  await exec(db, 'PRAGMA foreign_keys = OFF');
  try {
    await exec(db, LEDGER_REBUILD_SQL);
    // A rebuild that left a dangling reference would corrupt every joined
    // report, so the check is part of the migration rather than a later test.
    const violations = await all<Record<string, unknown>>(db, 'PRAGMA foreign_key_check');
    if (violations.length > 0) {
      throw new Error(`ledger rebuild left ${violations.length} broken references`);
    }
  } finally {
    await exec(db, 'PRAGMA foreign_keys = ON');
  }
}

/**
 * Append-only enforcement for `audit_events`.
 *
 * The two databases express this differently: SQLite raises from a trigger body
 * with `RAISE(ABORT, ...)`, PostgreSQL needs a trigger function that runs
 * `RAISE EXCEPTION`. Both are installed idempotently so a database that already
 * carried the old inline triggers (from before this was split out) upgrades
 * cleanly.
 */
const AUDIT_TRIGGERS_SQLITE = `
DROP TRIGGER IF EXISTS trg_audit_events_no_update;
DROP TRIGGER IF EXISTS trg_audit_events_no_delete;

CREATE TRIGGER trg_audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER trg_audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
`;

const AUDIT_TRIGGERS_POSTGRES = `
CREATE OR REPLACE FUNCTION daftari_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_no_update ON audit_events;
DROP TRIGGER IF EXISTS trg_audit_events_no_delete ON audit_events;

CREATE TRIGGER trg_audit_events_no_update
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION daftari_audit_events_append_only();

CREATE TRIGGER trg_audit_events_no_delete
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION daftari_audit_events_append_only();
`;

async function installAuditTriggers(db: Db): Promise<void> {
  await exec(db, db.kind === 'postgres' ? AUDIT_TRIGGERS_POSTGRES : AUDIT_TRIGGERS_SQLITE);
}

/**
 * Credential sign-in columns on `users`.
 *
 * Additive only: every column is nullable, so existing rows and rows created by
 * a managed identity provider keep working untouched. A user with a NULL
 * `password_hash` cannot sign in with a password and must use the provider path.
 *
 * The unique index is partial so that many provider-only users may all have a
 * NULL `email` — a plain UNIQUE constraint would allow only one of them.
 */
const CREDENTIAL_SIGNIN_SQL = `
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email
ON users (email)
WHERE email IS NOT NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: '0001_initial_schema', sql: INITIAL_SCHEMA },
  { id: '0002_sales_category', sql: SALES_CATEGORY_SQL },
  { id: '0003_session_token_hash', sql: SESSION_TOKEN_HASH_SQL },
  { id: '0004_ledger_amount_optional_for_stock', sql: LEDGER_REBUILD_SQL, run: rebuildLedgerTable },
  { id: '0005_audit_append_only', sql: AUDIT_TRIGGERS_SQLITE, run: installAuditTriggers },
  { id: '0006_credential_signin', sql: CREDENTIAL_SIGNIN_SQL },
];

export async function runMigrations(db: Db): Promise<string[]> {
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );
  const applied = new Set((await all<{ id: string }>(db, 'SELECT id FROM schema_migrations')).map((row) => row.id));
  const executed: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    if (migration.run) {
      // Structural rebuilds own their transaction handling, because the
      // prerequisite PRAGMA cannot run inside one.
      await migration.run(db);
      await run(db, 'INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)', [
        migration.id, checksum(migration.sql), nowIso(),
      ]);
      executed.push(migration.id);
      continue;
    }
    await withTransaction(async () => {
      await exec(db, migration.sql);
      await run(db, 'INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)', [
        migration.id, checksum(migration.sql), nowIso(),
      ]);
    }, db);
    executed.push(migration.id);
  }
  return executed;
}

export async function appliedMigrations(db: Db): Promise<string[]> {
  return (await all<{ id: string }>(db, 'SELECT id FROM schema_migrations ORDER BY id')).map((row) => row.id);
}

export async function currentMigration(db: Db): Promise<string | undefined> {
  return (await get<{ id: string }>(db, 'SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1'))?.id;
}

/** FNV-1a: enough to detect accidental edits to an applied migration. */
function checksum(sql: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sql.length; index += 1) {
    hash ^= sql.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}