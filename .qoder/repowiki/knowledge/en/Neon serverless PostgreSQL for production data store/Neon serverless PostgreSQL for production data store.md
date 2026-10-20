---
kind: external_dependency
name: Neon serverless PostgreSQL for production data store
slug: neon-postgresql
category: external_dependency
category_hints:
    - vendor_identity
    - migration_status
scope:
    - '**'
---

### Neon PostgreSQL
- Role: Production relational database; the project's async DB boundary (`src/server/db/client.ts`) uses `@neondatabase/serverless` Pool when `DATABASE_URL` or `NEON_DATABASE_URL` is set.
- Migration status: SQLite (via Node's built-in `DatabaseSync`) is a local/test-only fallback; production requires Neon and throws if neither env var is present in production.
- Verify exact connection options against the Neon docs.