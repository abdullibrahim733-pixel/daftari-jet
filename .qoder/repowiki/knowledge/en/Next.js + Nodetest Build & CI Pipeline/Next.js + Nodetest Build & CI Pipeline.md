---
kind: build_system
name: Next.js + Node:test Build & CI Pipeline
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - .github/workflows/ci.yml
    - vercel.json
    - next.config.ts
    - tsconfig.json
    - scripts/register-alias.mjs
---

## Build System Overview

Daftari Dashboard is a Next.js 16 application built entirely with npm scripts, TypeScript (no emit), and the native `node:test` runner. There is no Makefile, Dockerfile, or custom build toolchain — the project relies on Next.js's built-in compiler/bundler and GitHub Actions for CI.

## Key Files

- `package.json` — single source of truth for scripts, dependencies, and the `engines.node >=24.0.0` constraint.
- `.github/workflows/ci.yml` — GitHub Actions pipeline that runs typecheck, lint, test, build, and dependency audit.
- `vercel.json` — Vercel deployment config; schedules a cron at `/api/cron/jobs` (`0 3 * * *`) to drain the durable job queue.
- `next.config.ts` — Next.js runtime config (security headers, strict mode).
- `tsconfig.json` — Strict TS config with `noEmit`, `moduleResolution: "bundler"`, `paths.@/* → ./src/*`, and the Next.js plugin.
- `scripts/register-alias.mjs` — Minimal ESM hook that resolves `@/` aliases and bundler-style extensionless relative imports so `node --test` can run server-side TS without a bundler.

## Scripts and Conventions

| Script | Purpose |
|---|---|
| `dev` | `next dev` |
| `build` | `next build` |
| `start` | `next start` |
| `lint` | `eslint .` |
| `typecheck` | `tsc --noEmit` |
| `test` / `test:watch` | `node --import ./scripts/register-alias.mjs --test "tests/**/*.test.ts"` |
| `db:migrate` / `db:seed` / `db:reset` | CLI wrappers around `scripts/migrate.ts`, `scripts/seed.ts`, `scripts/reset-db.ts` |
| `jobs:run` | Drives `scripts/run-jobs.ts` |
| `verify` | Composite gate: `typecheck && lint && test` |

All script invocations use the same bootstrap pattern:
```
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-alias.mjs <script>
```
The `--disable-warning` flag suppresses a Node warning about typeless package JSON, and the `--import` hook registers the `@/` path alias before any module loads.

## CI Pipeline (`.github/workflows/ci.yml`)

Two jobs run on push/PR against `main` and `master`:

1. **`verify`** — checks out code, sets up Node 24 (matching `engines.node`), runs `npm ci`, then `npm run verify` (typecheck + lint + test). A second pass of `npm run test` pipes output through `grep '^# (pass|fail)'` as an explicit smoke check, and a final grep for `^not ok` fails the job if any test failed. Then `npm run build` runs in production mode (`NODE_ENV=production`) with `DAFTARI_ALLOW_DEV_LOGIN=1` set to assert that the prod build does not enable developer sign-in.
2. **`dependency-audit`** — installs deps and runs `npm audit --audit-level=high`.

Concurrency is configured to cancel in-progress runs on the same workflow/ref to avoid burning minutes on stale branches.

## Testing Strategy

Tests are plain TypeScript files under `tests/` using Node's built-in `node:test` runner. They target server-side modules only (JSX is not supported because Node strips types rather than compiling them). The suite uses a local SQLite database by default, so CI requires no secrets or service containers.

## Deployment

There is no Docker image or release artifact produced by this repo. Deployment is via Vercel (indicated by `vercel.json` and the Next.js setup). The Vercel cron entry schedules the job queue drain endpoint nightly at 03:00 UTC.

## Constraints Enforced by Configuration

- Node version is pinned to `>=24.0.0` in `package.json` engines and matched by `actions/setup-node` in CI.
- TypeScript compilation is disabled (`noEmit: true`); Next.js handles all transpilation.
- Path aliases are defined in `tsconfig.json` (`@/* → ./src/*`) and mirrored in `scripts/register-alias.mjs` so tests and scripts resolve identically to the bundler.
- The `verify` npm script is the canonical pre-commit/CI gate combining typecheck, lint, and test.
- Production builds must be runnable with `NODE_ENV=production`; the CI build step explicitly sets it to catch dev-only features leaking into the prod bundle.