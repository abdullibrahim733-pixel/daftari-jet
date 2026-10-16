import { randomUUID } from 'node:crypto';

/** Server-generated opaque identifiers. Never provider or storage keys. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Renders an epoch bound for comparison against a stored ISO timestamp.
 *
 * `occurred_at` is TEXT, and SQLite orders every TEXT value after every
 * INTEGER, so binding raw milliseconds makes a range query silently match
 * nothing. Converting to the same canonical ISO form keeps the comparison
 * lexicographic, chronological and index-friendly.
 */
export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** SQLite has no boolean type; store 0/1 explicitly. */
export function toSqlBool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromSqlBool(value: number | null | undefined): boolean {
  return value === 1;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}