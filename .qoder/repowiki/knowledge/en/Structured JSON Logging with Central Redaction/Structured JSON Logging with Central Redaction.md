---
kind: logging_system
name: Structured JSON Logging with Central Redaction
category: logging_system
scope:
    - '**'
source_files:
    - src/server/observability/logger.ts
    - src/server/http/route.ts
    - src/app/api/v1/auth/sign-in/route.ts
    - src/app/api/v1/auth/register/route.ts
    - src/app/api/v1/webhooks/whatsapp/route.ts
    - src/app/api/cron/jobs/route.ts
    - src/server/services/audit.ts
    - src/server/services/confirmation.ts
    - src/server/services/corrections.ts
    - src/server/services/jobs.ts
    - src/server/services/pipeline.ts
---

## System Overview

Daftari uses a minimal, self-contained structured logging module at `src/server/observability/logger.ts`. It is not built on an external logging framework — it serializes log lines as JSON and writes them to the Node.js process output via `console.info` / `console.warn` / `console.error`, relying on the hosting platform (Vercel) to capture stdout/stderr.

The module also exports an analytics helper (`trackEvent`) that emits analytics events through the same logger, gated by `DAFTARI_ANALYTICS_ENABLED=1`.

## Key Files

- `src/server/observability/logger.ts` — single source of truth for all logging and analytics emission.
- Consumers import via the alias `@/server/observability/logger` from API routes and server services:
  - `src/app/api/cron/jobs/route.ts`
  - `src/app/api/v1/auth/register/route.ts`
  - `src/app/api/v1/auth/sign-in/route.ts`
  - `src/app/api/v1/webhooks/whatsapp/route.ts`
  - `src/server/http/route.ts`
  - `src/server/services/audit.ts`
  - `src/server/services/confirmation.ts`
  - `src/server/services/corrections.ts`
  - `src/server/services/jobs.ts`
  - `src/server/services/pipeline.ts`

## Architecture and Conventions

### Log Line Shape
Every emitted line is a JSON object with these fields:

| Field | Value |
|---|---|
| `timestamp` | ISO-8601 string (`new Date().toISOString()`) |
| `level` | One of `'debug' | 'info' | 'warn' | 'error'` |
| `service` | Literal `'daftari-dashboard'` |
| `environment` | `process.env.NODE_ENV` (defaults to `'development'`) |
| `message` | Human-readable event name or description |
| `...context` | Redacted key-value pairs from `LogContext` |

### Structured Context Fields
Callers pass a typed `LogContext` object. The documented, first-class fields are:

- `requestId` — request correlation ID
- `jobId` — job correlation ID
- `businessId` — opaque tenant identifier
- `entityId` — domain entity reference
- `operation` — operation name
- `durationMs` — timing metric
- `result` — outcome label
- `errorCode` — safe enumerated failure classification

Any additional keys are accepted via `[key: string]: unknown` but go through redaction.

### Redaction Policy
A regex-based sensitive-key filter blocks values whose keys match:

`transcript | text | audio | media_url | object_key | token | secret | password | authorization | signature | phone | sender | customer_name | note | description | payload | raw`

Matching keys are replaced with the literal `[redacted]`. String values are truncated to 240 characters; arrays become `[array:N]`; objects become `[object]`; unserializable values become `[unserialisable]`.

The module's top-level comment explicitly states the policy: "Raw transcripts, audio references, provider tokens, webhook bodies, customer contact details and full financial records never reach the log sink." This is enforced by the `SENSITIVE_KEY_PATTERN` in code.

### Request/Job Correlation
`newRequestId()` generates IDs with the `req_` prefix using `crypto.randomUUID()` (hyphens stripped, first 24 chars). Callers attach this to `requestId` in `LogContext` so downstream logs can be correlated.

### Analytics Events
`trackEvent(event, properties)` emits an info-level log with message `analytics:<event>` where `event` is one of the union type:

`business_created | whatsapp_connected | source_received | proposal_ready | proposal_opened | proposal_corrected | proposal_confirmed | proposal_rejected | record_corrected | export_requested`

Emission is opt-in: if `DAFTARI_ANALYTICS_ENABLED !== '1'`, the function returns without logging. Properties must be `string | number | boolean` only (no PII).

### Level Usage Convention
Observed usage across consumers follows a consistent naming scheme: messages are dot-prefixed event names (e.g. `auth.registered`, `webhook.accepted`, `http.unexpected_error`, `job.failed`, `pipeline.proposal_created`). Levels are used descriptively:
- `info` for successful operations and state transitions
- `warn` for degraded conditions (dead-lettered jobs)
- `error` for failures and unexpected exceptions
- `debug` is exported but not observed in current consumers

## Conventions and Constraints

- **Single sink**: All application logging goes through the `logger` object in `src/server/observability/logger.ts`; there is no per-module logger factory.
- **No external logging library**: The implementation depends only on `node:crypto` and Node's built-in `console.*` methods.
- **PII redaction is automatic**: Any context key matching the sensitive-key pattern is redacted before serialization — callers do not manually scrub fields.
- **Analytics require explicit opt-in**: Analytics events are suppressed unless `DAFTARI_ANALYTICS_ENABLED=1`.
- **Structured fields are typed**: `LogLevel` and `LogContext` types enforce the shape of emitted data.
- **Platform integration**: The module comments cross-reference `architecture.md` sections 9 and 13, indicating the platform-side log ingestion pipeline (Neon Loki, referenced in `.agents/skills/neon/references/logs-loki.md`) consumes these JSON lines.
- **Service/environment tagging**: Every line carries `service: 'daftari-dashboard'` and `environment` derived from `NODE_ENV`, enabling multi-environment filtering.