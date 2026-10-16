# Daftari AI — Application Architecture

**Status:** Implementation guidance  
**Product:** Voice-first, WhatsApp-native AI bookkeeper for Tanzanian small businesses  
**Application:** Daftari Dashboard  
**Audience:** Engineering team and AI coding agents  
**Related specification:** `PRD.md`

## 1. Architecture goals and invariants

The system receives business activity through WhatsApp, preserves the original source, transcribes and interprets it, presents a proposal for human review, and writes confirmed records to a tenant-scoped ledger. The dashboard is the review/control center. WhatsApp remains the default capture channel.

### Core pipeline

```text
WhatsApp event
  → authenticated webhook
  → idempotent source event + encrypted media
  → asynchronous transcription
  → structured extraction proposal
  → validation and review queue
  → authorized human decision
  → confirmed ledger + immutable audit event
  → tenant-scoped dashboard aggregates/reports
```

### Non-negotiable invariants

1. **AI never commits a financial ledger record.** It creates proposals only. A human with permission confirms.
2. **Source first.** Preserve source identity and lineage through transcript, proposal, decision, ledger record, correction, and export.
3. **Tenant scope is mandatory.** Every query and mutation is scoped to the active tenant/business and authorized server-side.
4. **Idempotency at boundaries.** Webhooks, jobs, retries, confirmation, payment ingestion, and exports cannot duplicate side effects.
5. **Financial history is auditable.** Corrections are versioned or reversed; do not silently overwrite or delete posted history.
6. **Separate event receipt from processing success.** A webhook 200 means accepted/deduplicated, not necessarily transcribed or booked.
7. **Minimize sensitive data.** Audio, transcript, customer identifiers, and financial values stay out of ordinary logs and analytics.
8. **Every external provider is replaceable behind an adapter.** Do not couple domain logic to one AI, speech, storage, or WhatsApp vendor.

## 2. Recommended implementation baseline

The existing repository’s conventions take precedence. If the repository has no established stack, use this practical baseline:

- **Web:** TypeScript, React, Next.js App Router, server-side session checks, responsive component system.
- **API:** Next.js server routes for a small MVP or a separate TypeScript service if webhook/worker needs justify it. Keep domain services independent of route handlers.
- **Database:** PostgreSQL with migrations and row-level or equivalent tenant guards. Use a typed SQL layer/ORM only if it supports explicit transactions and migrations.
- **Queue:** managed durable queue with dead-letter handling; Redis-backed queue is acceptable for an early deployment if persistence and recovery are configured.
- **Media storage:** private object storage, server-side encryption, short-lived signed URLs, lifecycle deletion.
- **Authentication:** managed identity provider using secure HTTP-only cookies, MFA support for owners/admins where available, and verified email/phone flows.
- **Observability:** structured application logs, metrics, traces, error tracking, and queue/provider health dashboards.
- **Deployment:** separate development, staging, and production environments; managed PostgreSQL, queue, and object storage; infrastructure secrets in a secret manager.

These are defaults, not hidden product requirements. The coding agent must inspect the repository before adding frameworks or replacing existing choices.

## 3. System context and trust boundaries

```text
Merchant / team browser
        │ TLS + authenticated session
        ▼
Web app / API ─────────────── PostgreSQL (tenant data, jobs, audit)
        │                              │
        ├── private object storage     └── durable job queue
        │                                      │
WhatsApp provider webhook                    workers
        │                                      ├── speech adapter
        └── webhook ingress                    ├── extraction adapter
                                               └── validation/domain services
```

External trust boundaries: WhatsApp/provider callbacks, speech-to-text vendor, model provider, object storage, identity provider, and any payment data source. Verify signatures/tokens at ingress, constrain provider permissions, encrypt in transit/at rest, and treat all external payloads/model output as untrusted input.

### Service responsibilities

- **Web client:** render tenant-scoped data, validate forms for usability, show source lineage and state. Client validation is not a security boundary.
- **API/domain layer:** authenticate, authorize, validate, enforce tenant rules, transact ledger changes, create audit events, and expose stable contracts.
- **Webhook ingress:** verify signature, normalize provider payload, persist idempotently, queue work, respond quickly.
- **Workers:** fetch/decrypt media using scoped credentials, call adapters, validate output, persist processing state, retry transient faults, and move permanent failures to a visible failure state.
- **Database:** canonical source, proposal, ledger, membership, and audit state.
- **Object storage:** private audio and optional derived artifacts with explicit retention.
- **Queue:** at-least-once execution is expected; handlers must be idempotent.

## 4. Data model

Use UUID/ULID identifiers generated by the server. Store timestamps in UTC; render in the business timezone. Store monetary values as integer minor units plus ISO currency code; TZS uses two decimal places in standards but user-facing amounts should avoid unnecessary decimal zeros. Never use floating-point for money.

Every tenant-owned table has `business_id` (or a carefully documented parent relation) and indexes that begin with tenant key for common access patterns. Add database constraints for valid states and relationships.

### Core entities

#### `users`

- `id`, identity provider subject, verified contact reference, display name, status, created/updated timestamps.
- Do not copy provider access tokens into this table.

#### `businesses`

- `id`, `name`, `business_type`, optional location fields, `timezone` default `Africa/Dar_es_Salaam`, `currency` default `TZS`, `locale`, `status`, feature flags, created/updated timestamps.

#### `business_memberships`

- `id`, `business_id`, `user_id`, role (`owner`, `manager`, `staff`), permission overrides only if product explicitly supports them, invited/accepted/revoked timestamps, inviter.
- Unique active membership for `(business_id,user_id)`.
- Enforce one active owner minimum; owner transfer is an explicit audited workflow.

#### `integrations`

- `id`, `business_id`, provider, external account/phone reference (minimized/encrypted as appropriate), status, scopes, connected/disconnected timestamps, last webhook time, health metadata.
- Provider secrets live in secret manager or encrypted secret store, never plaintext logs/UI.

#### `source_events`

- `id`, `business_id`, `integration_id`, `provider_event_id`, `event_type`, `sender_ref` (pseudonymized/minimized), `received_at`, `provider_sent_at`, `dedupe_key`, `payload_ref` or redacted normalized payload, `status`, `failure_code`, created timestamp.
- Unique `(integration_id, provider_event_id)` or equivalent idempotency key.
- Store only fields needed for processing and evidence. Raw webhook body retention must be justified and time-limited.

#### `media_assets`

- `id`, `business_id`, `source_event_id`, private `object_key`, media type, byte size, duration, checksum, encryption metadata, retention deadline, deletion timestamp, access classification.
- Never store public URLs. Signed URLs are short-lived and issued only after authorization.

#### `transcripts`

- `id`, `business_id`, `source_event_id`, `media_asset_id` nullable, `text` encrypted/field protected according to data policy, detected language, provider/model version, quality metadata, status, created timestamp.
- Preserve original machine transcript separately from user-corrected text/version.

#### `proposals`

- `id`, `business_id`, `source_event_id`, `transcript_id`, `record_type`, state (`queued`, `processing`, `needs_review`, `needs_details`, `failed`, `confirmed`, `rejected`, `duplicate`), schema version, model/provider/version, normalized proposal JSON, field provenance/confidence, missing fields, validation issues, duplicate candidates, optimistic `version`, created/updated timestamps.
- Proposal data is not part of ledger aggregates.

#### `ledger_records`

- `id`, `business_id`, `record_type`, `occurred_at`, `currency`, `amount_minor` where applicable, normalized description, customer/payee references, status (`posted`, `voided`, `reversed`), `source_event_id` nullable only for explicit manual entry, `proposal_id` nullable, `created_by_user_id`, `confirmed_at`, version, created/updated timestamps.
- Use child tables or typed tables for record-specific attributes; avoid a giant unvalidated JSON blob as the only record store.
- For stock, store movements and derive balance. For deni, model obligations and payments with explicit relationships.

#### Type-specific tables

- `sales`: `ledger_record_id`, payment status/method, optional external reference.
- `expenses`: `ledger_record_id`, category, vendor.
- `debt_obligations`: `ledger_record_id`, customer id, original amount, due date, state.
- `debt_payments`: `ledger_record_id`, obligation id, amount applied, method/reference.
- `line_items`: parent record, item description/item id, quantity decimal, unit, unit price minor, line amount minor.
- `inventory_items`, `inventory_movements`: business-scoped item/unit and signed movement with source record.
- `business_notes`: source-linked non-financial note with privacy classification.

#### `customers` / `contacts`

- Business-scoped ID, display name, normalized contact reference only when needed, optional channel identifier, status, created/updated timestamps.
- Avoid global cross-business customer identity linking by default.

#### `audit_events`

- `id`, `business_id`, actor type/id, action, entity type/id, event time, request/correlation ID, reason, redacted before/after snapshot or version references, source, IP/device metadata only where justified, integrity metadata.
- Append-only application access; restrict updates/deletes to controlled retention tooling.
- Do not put secrets, full audio, or unnecessary PII in event payloads.

#### `outbox_events` and `job_runs`

- Transactional outbox rows for reliable downstream work.
- Job records include job type, entity key, attempt count, status, lease/heartbeat, next attempt, provider correlation ID, safe failure code, and timing metrics.

### Data relationship sketch

```text
business ─ memberships ─ users
   ├─ integrations ─ source_events ─ media_assets
   │                       ├─ transcripts ─ proposals
   │                       └──────────────────────┐
   ├─ ledger_records ◀── confirmed proposal       │
   ├─ customers                                   │ source lineage
   ├─ audit_events ───────────────────────────────┘
   └─ inventory / debt / report data
```

## 5. API contracts

Use JSON over HTTPS, versioned under `/api/v1`. Use a common envelope for errors, standard HTTP status codes, request correlation IDs, cursor pagination, and ISO-8601 timestamps. Return opaque IDs, never object storage keys or provider secrets. Responses must not expose data outside the selected business.

### Authentication and workspace context

Resolve authenticated user from server-verified session. Client may send `X-Active-Business-Id` as a selector, but server must verify active membership and permissions on every request. Do not trust business ID embedded in a body without checking it against the route/session scope.

### Common error format

```json
{
  "error": {
    "code": "PROPOSAL_VERSION_CONFLICT",
    "message": "This proposal changed while you were reviewing it.",
    "requestId": "req_opaque",
    "details": { "currentVersion": 4 }
  }
}
```

Do not include stack traces, raw provider errors, transcript text, or sensitive values in error responses.

### Endpoint set

#### `GET /api/v1/businesses`

List businesses current user can access. No cross-tenant aggregation.

#### `POST /api/v1/businesses`

Create business and owner membership atomically.

```json
{
  "name": "Amani Shop",
  "businessType": "retail",
  "timezone": "Africa/Dar_es_Salaam",
  "currency": "TZS",
  "locale": "sw-TZ"
}
```

#### `GET /api/v1/dashboard/summary?from=...&to=...`

Return confirmed-only totals, comparison coverage, review counts, chart buckets, freshness, and formula version. Date boundaries are interpreted in the business timezone and returned explicitly.

```json
{
  "businessId": "biz_...",
  "currency": "TZS",
  "timezone": "Africa/Dar_es_Salaam",
  "period": { "from": "2026-10-01", "toExclusive": "2026-10-08" },
  "confirmedTotals": {
    "salesMinor": 12000000,
    "expensesMinor": 4200000,
    "netCashMovementMinor": 7800000,
    "outstandingDebtMinor": 2500000
  },
  "reviewCount": 3,
  "dataAsOf": "2026-10-08T11:02:03Z",
  "calculationVersion": "cash-summary-v1"
}
```

#### `GET /api/v1/proposals?state=needs_review&cursor=...&limit=...`

Return proposal summary plus source metadata allowed for this role. Do not return audio bytes. Support stable cursor pagination and validated filters.

#### `GET /api/v1/proposals/{proposalId}`

Return full proposal, field provenance, transcript, source details, version, and decision state after business/role check.

#### `POST /api/v1/proposals/{proposalId}/confirm`

Require `Idempotency-Key`, expected proposal version, explicit editable values, and confirmation intent. Server reruns validation and permission checks, then creates the ledger record, marks proposal confirmed, and appends audit/outbox records in one database transaction.

```json
{
  "expectedVersion": 3,
  "record": {
    "type": "sale",
    "amountMinor": 1500000,
    "currency": "TZS",
    "occurredAt": "2026-10-04T15:10:00+03:00",
    "paymentStatus": "paid",
    "paymentMethod": "mobile_money",
    "description": "Rice sales"
  },
  "confirm": true
}
```

Return `201` with `ledgerRecordId`, `proposalId`, final normalized record, audit event ID, and summary effect. Repeated idempotency key returns the same result. Different body with reused key returns conflict.

#### `POST /api/v1/proposals/{proposalId}/reject`

Body: `{ "expectedVersion": 3, "reasonCode": "not_a_business_record", "note": "..." }`. Preserve source/proposal; audit decision. Restrict free-text note length and redact in logs.

#### `POST /api/v1/proposals/{proposalId}/retry`

Retry only transient/permitted failed states. Requires permission and idempotency. Do not overwrite a human-corrected transcript/proposal silently; create a new processing attempt/version.

#### `GET /api/v1/records?from=...&to=...&type=...&cursor=...`

Search and list confirmed records. Enforce tenant filters in query layer and database boundary.

#### `GET /api/v1/records/{recordId}`

Return record, source lineage, current version, related entities, and authorized audit history.

#### `POST /api/v1/records/{recordId}/corrections`

Create correction/reversal with `Idempotency-Key`, `expectedVersion`, reason, and explicitly typed changes. Never accept arbitrary direct status mutation from client.

#### `GET /api/v1/debts` and `GET /api/v1/debts/{id}`

Return confirmed obligations, applied payments, balance formula version, and lineage.

#### `POST /api/v1/exports`

Create async export job with date range, types, and format. Check export permission. Return export job ID; issue short-lived authorized download after ready. Audit creation and download. Expire object according to policy.

#### `GET /api/v1/integrations/whatsapp` / `POST /api/v1/integrations/whatsapp/connect`

Report status and launch provider authorization flow. Callback endpoint verifies state/nonce. Never accept provider credentials from arbitrary client JSON.

#### `POST /api/v1/webhooks/whatsapp/{provider}`

Verify provider signature and timestamp; reject invalid signature; parse allowlisted fields; persist event with unique provider ID; enqueue via transactional outbox; return promptly. Provider-specific challenge/verification handled according to adapter.

### Contract conventions

- Use `409` for optimistic-lock/idempotency conflicts; `422` for valid JSON with invalid business fields; `401/403` for identity/permission; `404` for absent or cross-tenant resource (avoid tenant enumeration); `429` for limits.
- Cursor pagination response: `items`, `nextCursor`, `hasMore`.
- Require CSRF defenses for cookie-authenticated mutations.
- Validate request and response schemas at boundaries and version proposal schemas.
- Include `requestId` in all responses and structured logs.

## 6. Ingestion, transcription, and extraction pipeline

### 6.1 Webhook receive

1. Enforce HTTPS, provider signature verification, timestamp tolerance, and request-size limits.
2. Validate provider event shape with a versioned schema; allowlist event types and media MIME types.
3. Resolve integration to a business through stored provider identity, never through untrusted payload-supplied tenant ID.
4. Create `source_events` with unique provider event ID. Duplicate delivery returns accepted response without duplicate job.
5. Write outbox job in same transaction. Respond quickly after durable acceptance.
6. Record only minimal, redacted webhook metadata. Never log raw payload by default.

### 6.2 Media acquisition

- Fetch media using provider’s short-lived URL/credential on worker, not browser.
- Validate MIME type, actual file signature, size, duration, and malware/unsafe-file policy.
- Encrypt and store in private object storage using opaque keys; store checksum and retention deadline.
- For unsupported/oversized media, mark a user-visible failure and retain enough source metadata to explain it.
- Signed playback URL is issued only after authorization, expires quickly, and is not written to logs.

### 6.3 Transcription

Speech adapter input: authorized media stream/object reference, tenant policy, language hints only if configured. Output: transcript text, detected language, segment timestamps (optional), provider/model version, quality/uncertainty metadata, and safe failure code.

Requirements:

- Support Swahili and English as an explicit product requirement; evaluate code-switching in field data.
- Preserve machine transcript version and any human-corrected version separately.
- Use provider timeout, bounded retries, and circuit breaker. Never keep retrying a permanent unsupported-media error.
- Send only data approved by the provider/privacy contract. Offer provider/model abstraction to support approved regional or local alternatives.

### 6.4 Structured extraction

Use a strict, versioned schema. A proposal should include:

```json
{
  "schemaVersion": "proposal-v1",
  "intent": "sale",
  "fields": {
    "amountMinor": { "value": 1500000, "currency": "TZS", "sourceSpan": "elfu kumi na tano", "confidence": 0.93 },
    "occurredAt": { "value": "2026-10-04T15:10:00+03:00", "sourceSpan": "leo", "confidence": 0.72 },
    "paymentStatus": { "value": "paid", "sourceSpan": "amelipa kwa M-Pesa", "confidence": 0.88 }
  },
  "missingFields": [],
  "ambiguities": [],
  "modelVersion": "provider-model-version"
}
```

All returned model output is untrusted. Validate JSON schema, enum values, amount bounds, currency, timezone/date interpretation, and field provenance. If a value lacks evidence or is ambiguous, represent it as missing/uncertain. Do not fabricate a default such as “paid” from an amount statement. Distinguish “merchant said paid via mobile money” from verified payment settlement.

Extraction should support multiple events in a message only when the model can split them with field-level source spans. Otherwise create a clarification proposal, not several guessed entries. Classify non-financial business notes separately.

### 6.5 Domain validation and review routing

Apply deterministic rules after model parsing:

- Reject invalid/non-finite/out-of-range amount; preserve source wording for clarification.
- Do not infer merchant currency from the model; default business currency only if policy allows and make editable.
- Validate date in business timezone, with explicit handling for relative words such as today/yesterday.
- Validate customer, debt, and item matching against business-scoped entities. Use candidate matches; do not auto-merge contacts.
- Flag likely duplicates using business, amount, timestamp, source, and description; this is a review cue, not automatic deletion.
- Route proposals with missing required fields or low quality to `needs_details`; route schema/provider failures to `failed` with retry guidance.
- Store confidence internally for evaluation/triage; user-facing UI should explain what to check rather than present false precision.

### 6.6 Human decision

Confirmation transaction:

1. Lock/compare proposal version and ensure state is reviewable.
2. Reauthorize active user and action against business membership/role.
3. Validate submitted typed record from scratch.
4. Check idempotency key.
5. Insert typed ledger record and links.
6. Mark proposal confirmed and save final accepted values/version.
7. Insert audit event and outbox event in the same transaction.
8. Commit; asynchronously refresh aggregates/notifications.

If any step fails, all ledger-facing effects roll back. Rejection is also atomic with proposal state and audit event. Corrections use a new version or reversal record, never an untracked overwrite.

## 7. Queue, retries, and failure handling

### Job types

`acquire_media`, `transcribe_source`, `extract_proposal`, `validate_proposal`, `refresh_summary`, `build_export`, `delete_expired_media`, and `provider_health_check`.

### Reliability policy

- Assume at-least-once delivery; every handler is idempotent by entity and attempt key.
- Use bounded exponential backoff with jitter for network, timeout, 429, and transient 5xx errors.
- Respect `Retry-After` where provided.
- Do not retry invalid schema, unsupported media, revoked consent, or permanent authorization errors without user/provider action.
- Record job attempt, safe failure class, provider request ID, elapsed time, and next retry.
- After bounded retries, mark failed and make it visible with a manual retry or support path.
- Use dead-letter queue and an operator replay workflow that preserves idempotency and audit metadata.
- Apply per-business/provider rate limits, concurrency caps, maximum audio size/duration, and spend alarms.
- A retry must not duplicate source, proposal, ledger, payment, or export effects.

### User-visible failure mapping

| Technical condition | Dashboard behavior |
|---|---|
| Provider event accepted; job pending | “Received — processing” with received time |
| Transcription delayed | “Transcription is taking longer than usual”; retain queue status |
| Unclear audio | Show transcript if available; ask user to retry or correct text |
| Unsupported/too long file | Explain reason and recommend supported voice note |
| Extraction uncertain | “Check details” and show missing fields |
| Temporary provider outage | Keep source, retry automatically, show delayed state |
| Permanent failure | Show source and safe error; allow retry if safe or contact support |
| WhatsApp disconnected | Show last successful event and reconnection steps |
| Concurrent decision | Refresh/reconcile; never silently overwrite |

## 8. Tenancy, authentication, and RBAC

### Tenant boundaries

- Business is the tenant boundary for financial records, integration events, media, customers, reports, and audit events.
- Every repository method requires a `BusinessContext` created by verified server middleware; avoid optional tenant parameters.
- Verify ownership of parent and child IDs together. An ID from another business must not be usable through a nested endpoint.
- Add database constraints and row-level security as defense in depth where supported. Application tests must still verify it.
- Cache keys include business ID, user permission/version, query arguments, and locale where relevant. Never cache unscoped financial responses.
- Background jobs carry business ID and are revalidated against stored entity ownership when executed.
- Exports and signed media URLs are tenant-authorized and short-lived.

### Authentication

- Use a managed OIDC/OAuth identity provider; use authorization code flow with PKCE.
- Web session is secure, HTTP-only, same-site cookie with rotation and revocation.
- Verify account contact before sensitive integration setup or account recovery.
- Rate-limit login, OTP, invitations, and recovery paths; prevent account enumeration.
- Require step-up confirmation for owner transfer, integration changes, bulk export, and deletion requests as risk warrants.

### Authorization

Implement centralized permission checks (e.g., `records.read`, `proposals.review`, `records.correct`, `team.manage`, `reports.export`, `integrations.manage`, `privacy.manage`). Map roles to permissions in one policy module. Check at route/service boundary and again inside sensitive domain operation. Deny by default.

## 9. Security, privacy, and data governance

This is a design baseline, not legal advice. Before launch, have local privacy/legal expertise validate Tanzania obligations, cross-border transfers, processor contracts, and retention practices.

### Data classification

| Class | Examples | Handling |
|---|---|---|
| Public | brand assets, public help copy | normal |
| Internal | feature flags, non-sensitive metrics | access-controlled |
| Confidential business | sales, expenses, customer names, team activity | tenant-scoped, encrypted, audited access |
| Highly sensitive | raw audio, transcripts, provider credentials, identity tokens | strict access, encryption, short retention, no analytics/logs |

### Controls

- TLS in transit; encryption at rest for database, backups, and object storage. Use managed keys/KMS where available, with rotation.
- Least-privilege service accounts; separate production credentials from development; no production data in local fixtures.
- Secrets in secret manager, rotation and access logging; never commit `.env` secrets.
- CSRF protection, secure cookies, strict CORS, content security policy, output encoding, parameterized queries, input limits, upload validation, and dependency scanning.
- Encrypt or otherwise protect transcript and customer contact fields where database access alone should not expose plaintext.
- Redact sensitive fields from logs, traces, exception reports, and analytics. Build redaction centrally and test it.
- Restrict audio playback and transcript access by role; record sensitive access in audit/security logs.
- Vendor review: data processing terms, data use for training, sub-processors, location, retention, deletion, incident notification, and breach handling.
- Define retention by artifact: webhook payload, audio, transcript, proposals, ledger, audit, exports, backups. Document the reason and deletion behavior for each.
- Support access/export/correction/deletion requests through a verified workflow. Deletion must account for legal retention, audit integrity, backups, and provider copies.
- Never train general models on private merchant data without a separate lawful basis and clear consent.
- Maintain incident response runbook, access review, backup restoration plan, and security contact.

### Privacy by design

Collect only what is needed for bookkeeping. Use phone numbers as references when possible; avoid enriching contacts from third-party sources by default. Provide clear notice about WhatsApp processing, AI providers, transcript/audio retention, and human review. Consent and lawful basis must be represented in integration state and checked before processing where required.

## 10. Auditability and financial correctness

Audit events should answer: who did what, to which business/entity, when, using what source, and why. Events include proposal created/edited/confirmed/rejected, ledger correction/reversal, membership/role change, integration connect/disconnect, export requested/downloaded, and sensitive media access.

Financial rules:

- Use integer minor units and explicit ISO currency.
- Distinguish `occurred_at` (business event time) from `created_at` (system time), `received_at`, `confirmed_at`, and `updated_at`.
- Store timezone on business and normalize timestamps to UTC; date filters use local business calendar boundaries.
- Define sign conventions and aggregation formulas in versioned domain functions. Add independent examples for refunds, partial payments, voids, reversals, and debt balance.
- Payment method/status reported in a voice note is a merchant assertion unless linked to an authorized provider verification event.
- Use database transactions and unique constraints to enforce exactly-once ledger effect under retries.
- Audit snapshots contain only necessary fields and follow a documented retention/integrity policy.

## 11. Frontend architecture and folder structure

Adapt to an existing repository. If greenfield, prefer feature-first organization:

```text
src/
  app/
    (auth)/sign-in/page.tsx
    (app)/layout.tsx
    (app)/overview/page.tsx
    (app)/review/page.tsx
    (app)/review/[proposalId]/page.tsx
    (app)/records/page.tsx
    (app)/records/[recordId]/page.tsx
    (app)/deni/page.tsx
    (app)/inventory/page.tsx
    (app)/reports/page.tsx
    (app)/settings/**/page.tsx
    api/v1/**/route.ts
  components/
    ui/                 # token-backed primitives
    layout/             # shell, navigation, business switcher
    data-display/       # amounts, dates, status, charts, tables
    feedback/           # empty, loading, error, stale, toast
  features/
    onboarding/
    overview/
    review/
    records/
    deni/
    inventory/
    reports/
    settings/
  server/
    auth/
    business-context/
    permissions/
    domain/             # ledger, proposals, debts, money, time
    repositories/
    integrations/
      whatsapp/
      speech/
      extraction/
      storage/
    jobs/
    audit/
    observability/
  lib/
    api-client/
    validation/
    localization/
    formatting/
  styles/
    tokens.css
    globals.css
  messages/
    en.json
    sw.json
  tests/
    unit/
    integration/
    e2e/
```

Suggested separate worker package when runtime requires long-lived/background process:

```text
worker/
  src/consumers/
  src/handlers/
  src/adapters/
  src/observability/
```

### Naming conventions

- React components and types: `PascalCase`; functions/variables: `camelCase`; constants: `UPPER_SNAKE_CASE` only for true constants.
- Database tables/columns: `snake_case`; identifiers named `id`, foreign keys `{entity}_id`.
- API JSON fields: `camelCase`; persisted enum values: stable lowercase snake_case.
- Use domain words consistently: `sourceEvent`, `proposal`, `ledgerRecord`, `businessId`; do not call a proposal a transaction before confirmation.
- Avoid vague names (`data`, `item`, `info`) in domain contracts.
- Keep provider-specific payload types inside adapter folders; normalize at the boundary.
- Localization keys use stable semantic identifiers, e.g., `review.confirm.button`, never use translated copy as key.
- Keep money/time formatting in shared formatters; never hand-format amounts in page components.

### UI data-flow rules

- Server-render or fetch sensitive initial data through authenticated server APIs where appropriate.
- Client cache keys include business ID and invalidation follows confirmation/correction. Clear tenant-scoped caches on business switch/logout.
- Use optimistic UI only for reversible non-financial preferences. For confirm/reject/correction, show pending state and wait for server result.
- Preserve unsaved form values through recoverable network errors; do not submit twice without idempotency key.
- API response types derive from validated schemas where possible; do not duplicate unchecked hand-written interfaces.

## 12. Backend module boundaries

Suggested domain services:

- `BusinessService`: workspace creation, settings, membership changes.
- `IntegrationService`: connection state, callback handling, consent and health.
- `SourceIngestionService`: webhook validation, source normalization, dedupe, outbox.
- `TranscriptionService`: provider-neutral transcription, artifact lifecycle.
- `ProposalService`: extraction, validation, routing, human transcript correction.
- `LedgerService`: confirm, query, correct, reverse, aggregate.
- `DebtService`: obligations, payment allocation, balance computation.
- `AuditService`: append-only business/security events and redaction.
- `ExportService`: permission checks, async generation, expiration, audit.
- `PermissionService`: centralized action decisions.

Routes should be thin: parse/validate input, establish context, call service, map errors to contract. Domain services should not depend on React or provider SDK types.

## 13. Observability and operations

### Structured logs

Include timestamp, severity, environment, service, request/correlation ID, job ID, business ID only as opaque ID, entity ID, operation, duration, result, and safe error code. Never log access tokens, secrets, raw webhook bodies, media URLs, audio/transcript, customer phone numbers, or full financial records.

### Metrics and alerts

- Webhook accepted/rejected, signature failures, dedupe count, provider latency.
- Queue depth/age, retries, dead-letter count, job duration by stage/provider.
- Transcription/extraction failure rates, schema-invalid rate, no-speech rate, language/quality slices with privacy-safe aggregation.
- Proposal review backlog age, correction rate, rejection rate, confirmation latency.
- API latency/error rate, DB pool saturation, storage errors, auth/authorization failures.
- Export creation/download and sensitive access anomaly alerts.
- Cost per source and provider spend thresholds.

Alerts should be actionable, routed to an owned on-call/support path, and avoid including merchant content. Define dashboard and SLO thresholds after baseline/pilot.

### Operational tools

Internal source/job lookup by opaque ID, safe retry/replay, integration health check, retention/deletion status, and export status. Every operator access to content must be authorized, minimized, and audited. Support tooling should not bypass tenant guards.

## 14. Testing strategy

Do not treat model output tests as a substitute for financial/domain tests. Keep golden examples consented, redacted, and representative across Swahili, English, code-switching, currency phrasing, noise, multiple events, and negation.

### Unit tests

- Money arithmetic, sign conventions, date boundaries/timezones, debt allocation, duplicate heuristics, schema validation, role-policy mapping, redaction, state transitions.
- Property tests for idempotency and aggregation invariants where tooling permits.

### Integration tests

- Database transaction rollback/commit, unique webhook keys, outbox behavior, tenant filters, object storage access, provider adapter contracts, signed media URL expiry.
- Confirmation inserts record + audit atomically; retry does not duplicate; correction preserves history.

### Contract tests

- Request/response schema compatibility, provider webhook versions/signature validation, model-output JSON validation, migrations from supported prior schema.

### End-to-end tests

1. Onboard a business and view empty state.
2. Simulate a signed inbound voice webhook; observe processing; confirm corrected sale; verify Overview/Records.
3. Reject a proposal and verify no total changes.
4. Re-deliver same webhook and verify one source/proposal.
5. Attempt cross-business API access and verify non-disclosure.
6. Exercise failed transcription, retry, and eventual recovery.
7. Correct a posted record and verify audit trail and recalculated totals.
8. Test keyboard-only review and narrow viewport behavior.

### AI evaluation

- Maintain labeled evaluation examples with correct intent, amount, currency, date, payment assertion, customer, and source spans.
- Measure field-level exactness, unsupported inference, missed event, duplicate proposal, calibration, and clarification rate.
- Slice by language/code-switching/audio quality and record type; review failures before model/provider changes.
- Set a release gate based on pilot evidence. Never remove human confirmation based on aggregate accuracy alone.

## 15. Deployment and environments

### Environments

- **Local:** synthetic fixtures and provider mocks; no production recordings or credentials.
- **Development:** isolated cloud resources and test WhatsApp number/provider app.
- **Staging:** production-like schema, queue, storage, access policies, and provider sandbox; synthetic or consented data only.
- **Production:** isolated secrets and service accounts, monitored backups, retention jobs, incident process, and controlled deploys.

### CI/CD sequence

1. Format/lint/typecheck.
2. Unit and integration tests with ephemeral database/queue or faithful test doubles.
3. Dependency, secret, and static security checks.
4. Build immutable artifact and generate migration plan.
5. Deploy to staging; run smoke and webhook contract checks.
6. Apply backward-compatible migrations; deploy application/worker in compatible order.
7. Canary/health check; monitor queue and error metrics.
8. Roll back app if needed; use forward-fix for irreversible schema changes. Never drop data as an automatic rollback.

### Database migration rules

- Version migrations; use expand/migrate/contract for breaking changes.
- Avoid destructive migration in same release as code deploy.
- Back up before high-risk schema or retention operations.
- Test migration from a production-like snapshot with synthetic/redacted data.
- Every schema change has tenant indexes, constraints, and rollback/forward plan documented.

### Backup and recovery

- Define RPO/RTO with product owner after provider selection.
- Enable encrypted automated backups and point-in-time recovery where available.
- Test restore regularly in isolated environment.
- Object retention/deletion must coordinate with backups and documented deletion commitments.

## 16. Implementation plan for an AI coding agent

### Before coding

1. Inspect repository, existing `AGENTS.md`, package scripts, routes, UI system, auth, persistence, and current deployment target.
2. Report detected stack and gaps; reuse established patterns.
3. Present a short implementation plan and identify unavailable provider credentials; continue using safe mocks for integration boundaries.
4. Create architecture/schema/API types before screens depend on undocumented data.

### Build order

**Phase A — Product shell**

- Add token file using exact brand colors and semantic tokens.
- Add localization infrastructure, app shell, business switcher, responsive navigation, shared state components.
- Implement business context and role checks.

**Phase B — Review-first vertical slice**

- Define proposal schema, source lineage, state machine, API schemas, fixture data.
- Build Review inbox and review detail with audio/transcript panel, editable typed form, confirmation summary, rejection reason, conflict/error states.
- Implement backend proposal confirmation/rejection with transaction, idempotency, and audit.

**Phase C — Ingestion pipeline**

- Implement WhatsApp adapter and signed webhook verification.
- Add source event dedupe, outbox, durable worker, private media storage, transcription and extraction adapters.
- Add deterministic validation, retry/dead-letter paths, and operational metrics.

**Phase D — Ledger and overview**

- Build typed ledger, correction/reversal, source detail, confirmed-only aggregation.
- Connect Records and Overview API; implement TZS/timezone formatting.

**Phase E — Supporting product surfaces**

- Add Deni, reports/export, team, settings, integration health.
- Feature-gate Inventory until item/unit setup and movement semantics are complete.

**Phase F — Hardening and pilot**

- Add tenant-isolation, accessibility, AI evaluation, redaction, retention jobs, monitoring, deployment/runbooks.
- Pilot with consent and inspect correction burden before widening scope.

### Definition of done per phase

- UI covers success, loading, empty, stale, error, retry, and permission/conflict states relevant to the feature.
- Tenant scope and authorization are enforced server-side.
- Inputs/outputs are schema-validated; errors are safe and actionable.
- State-changing actions have idempotency and audit behavior.
- Brand tokens/localization are shared, not duplicated.
- Tests cover business-critical behavior and established repository checks pass.
- No secrets, customer content, or raw model output enter logs.
- Documentation reflects changed contracts and operational behavior.

## 17. Non-negotiable AI-agent instructions

1. Do not invent repository APIs, provider capabilities, completed connections, or legal compliance. Inspect and label assumptions.
2. Never bypass tenant authorization to make a screen work.
3. Never commit AI extraction directly to the ledger or count proposals in totals.
4. Never delete or overwrite financial history to simplify editing.
5. Never treat “paid” in a transcript as independently verified settlement.
6. Never hard-code one provider SDK into domain logic; maintain adapters.
7. Never use floating-point for money or browser-local timezone for business dates.
8. Never include transcript/audio/contact/payment data in logs, analytics, screenshots, or sample fixtures without explicit approved handling.
9. Use exact brand tokens and centralized localization. Do not introduce another color system or page-specific financial terminology.
10. Implement accessible controls and explicit states; a polished screenshot without functioning review/permission/error flows is incomplete.
11. Preserve source lineage, actor, time, and reason for every human decision and correction.
12. When a requirement conflicts with the existing repository or provider constraints, document the conflict and propose the smallest safe adaptation before changing invariants.

## 18. Production readiness checklist

- [ ] Provider signatures and webhook replay protection verified.
- [ ] Tenant isolation tested at API, database, worker, cache, media, and export boundaries.
- [ ] Human confirmation is required and atomic with ledger/audit writes.
- [ ] Duplicate deliveries and job retries have idempotency coverage.
- [ ] Swahili/English quality evaluated on consented examples; uncertain cases route to review.
- [ ] Data processing, cross-border transfer, consent, retention, deletion, and vendor terms reviewed by qualified local counsel/privacy lead.
- [ ] Audio, transcript, financial data, tokens, and PII are absent from ordinary logs and analytics.
- [ ] Backups encrypted and restore tested; retention/deletion tested.
- [ ] Accessibility and contrast checked on final brand tokens.
- [ ] Alerts, queue replay, incident response, and support ownership are documented.
- [ ] Dashboard calculations validated for TZS, timezone, refunds, debt, partial payments, and reversals.
- [ ] Pilot acceptance criteria and correction-rate review are agreed before launch expansion.

