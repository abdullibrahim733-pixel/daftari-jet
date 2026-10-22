/**
 * Async database boundary for Neon PostgreSQL and local/test SQLite.
 *
 * Production must set DATABASE_URL (or NEON_DATABASE_URL); SQLite is only a
 * local/test fallback. Queries use the portable `?` placeholders, translated
 * to PostgreSQL parameters here so repositories never depend on a driver.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from '@neondatabase/serverless';

export type SqlValue = string | number | bigint | null | Uint8Array | boolean | Date;
export type SqlRow = Record<string, unknown>;
type SqliteBackend = { kind: 'sqlite'; connection: DatabaseSync };
type PostgresBackend = {
  kind: 'postgres';
  pool: Pool;
  transactionClient: AsyncLocalStorage<PoolClient>;
  transactionDepth: AsyncLocalStorage<number>;
};
export type Db =
  | { readonly kind: 'sqlite'; readonly backend: SqliteBackend }
  | { readonly kind: 'postgres'; readonly backend: PostgresBackend };

export type DatabaseConfig = { dataDir: string; filename?: string };

let cached: { path: string; db: Db } | null = null;

export function resolveDataDir(): string {
  const configured = process.env.DAFTARI_DATA_DIR?.trim();
  // SQLite is a local/test-only fallback; production uses PostgreSQL. Opt this
  // dynamic path out of Next.js file tracing so it doesn't pull the whole repo
  // (including /public) into the server bundle.
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), configured && configured.length > 0 ? configured : '.daftari');
}

export function databasePath(config?: Partial<DatabaseConfig>): string {
  const dataDir = config?.dataDir ? path.resolve(config.dataDir) : resolveDataDir();
  return path.join(/* turbopackIgnore: true */ dataDir, config?.filename ?? 'daftari.db');
}

/** Points local/test callers at a different SQLite file. */
export function configureDatabase(config: Partial<DatabaseConfig>): string {
  const nextPath = databasePath(config);
  if (cached && cached.path !== nextPath) void closeDatabase();
  return nextPath;
}

function shouldUsePostgres(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim() || process.env.NEON_DATABASE_URL?.trim());
}

export function getDatabase(config?: Partial<DatabaseConfig>): Db {
  if (shouldUsePostgres()) {
    const connectionString = process.env.DATABASE_URL?.trim() || process.env.NEON_DATABASE_URL?.trim();
    const cacheKey = `postgres:${connectionString}`;
    if (cached?.path === cacheKey) return cached.db;
    if (cached) void closeDatabase();
    const db: Db = {
      kind: 'postgres',
      backend: {
        kind: 'postgres',
        pool: new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 }),
        transactionClient: new AsyncLocalStorage<PoolClient>(),
        transactionDepth: new AsyncLocalStorage<number>(),
      },
    };
    cached = { path: cacheKey, db };
    return db;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL or NEON_DATABASE_URL must be configured in production');
  }
  const filePath = databasePath(config);
  if (cached && cached.path === filePath) return cached.db;
  if (cached) void closeDatabase();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db: Db = { kind: 'sqlite', backend: { kind: 'sqlite', connection: new DatabaseSync(filePath) } };
  db.backend.connection.exec('PRAGMA journal_mode = WAL');
  db.backend.connection.exec('PRAGMA foreign_keys = ON');
  db.backend.connection.exec('PRAGMA busy_timeout = 5000');
  db.backend.connection.exec('PRAGMA synchronous = NORMAL');
  cached = { path: filePath, db };
  return db;
}

export async function closeDatabase(): Promise<void> {
  const previous = cached;
  cached = null;
  if (!previous) return;
  if (previous.db.backend.kind === 'sqlite') previous.db.backend.connection.close();
  else await previous.db.backend.pool.end();
}

function normalizeParams(params: readonly unknown[]): unknown[] {
  return params.map((value) => {
    if (value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

function postgresPlaceholders(sql: string): string {
  let index = 0;
  let result = '';
  let quote: "'" | '"' | '`' | null = null;
  let dollarTag: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        result += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else result += char;
      continue;
    }
    if (quote) {
      result += char;
      if (char === quote && sql[i + 1] === quote) result += sql[++i]!;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      result += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        result += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      result += char === '`' ? '"' : char;
    } else if (char === '?') {
      result += `$${++index}`;
    } else result += char;
  }
  return result;
}

export async function run(db: Db, sql: string, params: readonly unknown[] = []): Promise<number> {
  if (db.backend.kind === 'sqlite') {
    const result = db.backend.connection.prepare(sql).run(...normalizeParams(params) as never[]);
    return Number(result.changes);
  }
  const backend = db.backend;
  const client = backend.transactionClient.getStore();
  const result = client
    ? await client.query(postgresPlaceholders(sql), normalizeParams(params))
    : await backend.pool.query(postgresPlaceholders(sql), normalizeParams(params));
  return result.rowCount ?? 0;
}

export async function get<T extends SqlRow = SqlRow>(
  db: Db,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  if (db.backend.kind === 'sqlite') {
    return db.backend.connection.prepare(sql).get(...normalizeParams(params) as never[]) as T | undefined;
  }
  const backend = db.backend;
  const client = backend.transactionClient.getStore();
  const result = client
    ? await client.query<T>(postgresPlaceholders(sql), normalizeParams(params))
    : await backend.pool.query<T>(postgresPlaceholders(sql), normalizeParams(params));
  return result.rows[0];
}

export async function all<T extends SqlRow = SqlRow>(
  db: Db,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  if (db.backend.kind === 'sqlite') {
    return db.backend.connection.prepare(sql).all(...normalizeParams(params) as never[]) as T[];
  }
  const backend = db.backend;
  const client = backend.transactionClient.getStore();
  const result = client
    ? await client.query<T>(postgresPlaceholders(sql), normalizeParams(params))
    : await backend.pool.query<T>(postgresPlaceholders(sql), normalizeParams(params));
  return result.rows;
}

/**
 * Splits a migration script on statement-terminating semicolons.
 *
 * A plain `split(';')` is wrong: a semicolon can live inside a string literal, a
 * quoted identifier, a line comment, a C-style block comment (Postgres allows
 * those to nest) or a `$tag$ ... $tag$` dollar-quoted function body. Ignoring
 * comments caused real breakage: an explanatory comment containing a semicolon
 * once split a `CREATE TRIGGER` statement in half.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | null = null;
  let dollarTag: string | null = null;
  let i = 0;
  const length = sql.length;
  while (i < length) {
    const char = sql[i]!;
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
      } else {
        current += char;
        i += 1;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote && sql[i + 1] === quote) current += sql[++i]!;
      else if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? length : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }
    if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
    } else if (char === ';') {
      if (current.trim().length > 0) statements.push(current.trim());
      current = '';
    } else current += char;
    i += 1;
  }
  if (current.trim().length > 0) statements.push(current.trim());
  return statements;
}

export async function exec(db: Db, sql: string): Promise<void> {
  if (db.backend.kind === 'sqlite') {
    db.backend.connection.exec(sql);
    return;
  }
  for (const statement of splitSqlStatements(sql)) await run(db, statement);
}

let sqliteSavepointCounter = 0;

/** Async transaction wrapper. AsyncLocalStorage routes nested repository calls
 * through the same PostgreSQL client, preserving atomic ledger confirmation.
 */
export async function withTransaction<T>(fn: () => Promise<T>, db: Db = getDatabase()): Promise<T> {
  if (db.backend.kind === 'sqlite') {
    const connection = db.backend.connection;
    if (connection.isTransaction) {
      sqliteSavepointCounter += 1;
      const savepoint = `daftari_sp_${sqliteSavepointCounter}`;
      connection.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = await fn();
        connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }
    connection.exec('BEGIN IMMEDIATE');
    try {
      const value = await fn();
      connection.exec('COMMIT');
      return value;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  const backend = db.backend;
  const existing = backend.transactionClient.getStore();
  if (existing) {
    const depth = (backend.transactionDepth.getStore() ?? 0) + 1;
    const savepoint = `daftari_sp_${depth}`;
    await existing.query(`SAVEPOINT ${savepoint}`);
    try {
      const value = await backend.transactionDepth.run(depth, fn);
      await existing.query(`RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      await existing.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  const client = await backend.pool.connect();
  await client.query('BEGIN');
  try {
    const value = await backend.transactionClient.run(client, () => backend.transactionDepth.run(0, fn));
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function isInTransaction(db: Db = getDatabase()): boolean {
  return db.backend.kind === 'postgres'
    ? Boolean(db.backend.transactionClient.getStore())
    : false;
}

export async function scalar<T extends SqlValue>(
  db: Db,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const row = await get<Record<string, unknown>>(db, sql, params);
  if (!row) return null;
  return (Object.values(row)[0] ?? null) as T | null;
}
