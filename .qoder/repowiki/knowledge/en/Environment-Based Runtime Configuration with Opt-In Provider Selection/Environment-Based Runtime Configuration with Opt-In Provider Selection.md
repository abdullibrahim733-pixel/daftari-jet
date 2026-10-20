---
kind: configuration_system
name: Environment-Based Runtime Configuration with Opt-In Provider Selection
category: configuration_system
scope:
    - '**'
source_files:
    - src/server/config/env.ts
    - src/server/integrations/index.ts
    - .env.example
---

## Overview

Daftari uses a single, centralized environment configuration module (`src/server/config/env.ts`) that reads exclusively from `process.env`. There is no `.env` parser library (e.g. dotenv) — the file reads raw `process.env` values directly. A companion `.env.example` documents every supported variable and their defaults.

The system is built around **opt-in provider selection**: every managed integration (WhatsApp, storage, speech-to-text, extraction) has a `DAFTARI_*_PROVIDER` selector whose default is an offline/local/mock adapter. This means a missing or empty variable never silently points a deployment at a real third-party service.

## Core Architecture

### Central config module: `src/server/config/env.ts`

Defines four small helpers for reading env vars:
- `optional(name)` — trims whitespace; returns `undefined` for empty strings.
- `required(name, purpose)` — throws a typed `ConfigError` when absent, with a message identifying the missing variable.
- `choice(name, allowed, fallback)` — validates against a union of string literals; the fallback is the safe local/mock default.
- `flag(name)` — parses `'1' | 'true' | 'yes'` as truthy.

Typed configuration groups are exported alongside selectors:
- `whatsappProvider()` → `'local' | 'twilio'`, default `'local'`; `whatsappIngestionEnabled()` toggles webhook intake via `DAFTARI_WHATSAPP_ENABLED`.
- `storageProvider()` → `'local' | 's3' | 'blob'`, default `'local'`.
- `speechProvider()` → `'mock' | 'openai'`, default `'mock'`.
- `extractionProvider()` → `'off' | 'mock' | 'openai'`, default `'mock'`.
- `openAiConfig()`, `s3Config()`, `twilioConfig()` — grouped credential objects.
- Misc: `cronSecret()`, `mediaUrlTtlSeconds()` (capped at 86400 s).

### Adapter wiring: `src/server/integrations/index.ts`

A single `createIntegrations()` factory reads all provider selectors and constructs the concrete adapters. The returned `Integrations` object exposes `storage`, `speech`, `extraction`, `whatsapp`. It is cached in a process-level variable and exposed through `integrations()`. Tests can swap providers via `overrideIntegrations(overrides)`.

This file is the only place where feature code branches on environment flags — the comment states this explicitly: "One module owns which implementation is in use, so no feature code ever branches on an environment flag."

### Consumers

Integration adapters import only the *types* they need from `@/server/config/env` (e.g. `OpenAiConfig`, `S3Config`, `TwilioConfig`), while the factory imports the runtime selectors. Route handlers import only the specific functions they need (e.g. `cronSecret`, `whatsappIngestionEnabled`).

## Supported Environment Variables

| Variable | Purpose | Default / Notes |
|---|---|---|
| `DAFTARI_DATA_DIR` | Local SQLite + media + exports directory | `.daftari` |
| `DATABASE_URL` / `NEON_DATABASE_URL` | Neon Postgres connection string | Empty → local SQLite |
| `DAFTARI_WEBHOOK_SECRET` | Signs WhatsApp webhook deliveries | Dev-only value in example |
| `DAFTARI_MEDIA_URL_TTL_SECONDS` | Signed private-media link lifetime | 300, capped at 86400 |
| `DAFTARI_ALLOW_DEV_LOGIN` | Enables dev sign-in route | Off unless set to `1` |
| `DAFTARI_CRON_SECRET` / `CRON_SECRET` | Authorizes scheduled job endpoint | Null if unset |
| `DAFTARI_WHATSAPP_ENABLED` | Enables WhatsApp ingestion path | `0` |
| `DAFTARI_WHATSAPP_PROVIDER` | WhatsApp adapter | `local` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` | Twilio credentials | Required when provider=`twilio` |
| `DAFTARI_STORAGE_PROVIDER` | Storage backend | `local` |
| `BLOB_STORE_ID` | Vercel Blob store id (OIDC-authenticated) | Required when provider=`blob` |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX`, `S3_SSE` | S3-compatible storage | Region defaults to `us-east-1`, prefix defaults to `daftari-media` |
| `DAFTARI_MEDIA_SIGNING_SECRET` | Cross-instance signed media verification | Required for managed deployments |
| `DAFTARI_SPEECH_PROVIDER` | Speech-to-text backend | `mock` |
| `DAFTARI_EXTRACTION_PROVIDER` | AI extraction mode | `off` |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_EXTRACTION_MODEL` | OpenAI credentials & model selection | Base URL defaults to `https://api.openai.com/v1` |
| Seed variables (`DAFTARI_SEED_SUBJECT`, etc.) | Development seed script | Dev only |

## Conventions and Rules

1. **All runtime configuration flows through `process.env`** — there is no `.env` loader library; values are read directly inside `optional`/`required`/`choice`/`flag`.
2. **Managed providers are opt-in** — every `*_PROVIDER` selector defaults to a local/mock/off implementation. A missing variable cannot accidentally connect to a production third party.
3. **Missing required credentials fail fast** — `required()` throws `ConfigError` at configuration load time with a message naming the missing variable and its purpose, rather than failing later inside a request handler.
4. **Boolean flags accept `1`, `true`, or `yes`** (case-insensitive); everything else is falsy.
5. **Feature code never branches on env vars directly** — provider selection is centralized in `createIntegrations()`. Route handlers and services consume typed adapters, not raw env values.
6. **Adapters receive only the types they need** — integration adapters import `OpenAiConfig`, `S3Config`, `TwilioConfig` from `@/server/config/env` but do not call the selectors themselves.
7. **Provider instances are process-scoped and cached** — `integrations()` memoizes the constructed `Integrations` object; `overrideIntegrations()` provides a test-time seam to swap implementations.
8. **`.env.example` is the canonical documentation** — it lists every supported variable with comments explaining purpose, defaults, and deployment-specific notes.
9. **Signed media links require a shared secret in managed deployments** — `s3Config()` calls `required('DAFTARI_MEDIA_SIGNING_SECRET', ...)` so deployments without a stable data directory cannot fall back to filesystem-based signing.
10. **Media URL TTL is bounded** — `mediaUrlTtlSeconds()` caps any parsed value at 86400 seconds (one day) and falls back to 300 seconds for invalid input.