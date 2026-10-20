---
kind: error_handling
name: 'Application Error Contract: AppError, ProviderError, and Route Wrapper'
category: error_handling
scope:
    - '**'
source_files:
    - src/lib/errors.ts
    - src/server/http/route.ts
    - src/server/integrations/provider-error.ts
    - src/app/(dashboard)/error.tsx
    - src/app/global-error.tsx
    - src/app/not-found.tsx
---

## Approach

The codebase uses a two-tier error model:

1. **Application errors** — `AppError` from `src/lib/errors.ts`, thrown by business logic and route handlers to signal domain-level failures with a stable HTTP status, a machine-readable `ErrorCode`, and optional JSON-safe `details`.
2. **Provider errors** — `ProviderError` from `src/server/integrations/provider-error.ts`, thrown by external integration adapters (OpenAI speech/extraction, Twilio WhatsApp, storage backends) to carry provider-specific codes plus a `retryable` flag that the job runner uses to decide between retrying with backoff and giving up.

Route handlers are wrapped in `route()` from `src/server/http/route.ts`, which is the single boundary that converts thrown errors into documented HTTP responses. Client-side Next.js error boundaries (`src/app/(dashboard)/error.tsx`, `src/app/global-error.tsx`, `src/app/not-found.tsx`) render user-facing pages for segment and root-level failures.

## Key Files

- `src/lib/errors.ts` — `ERROR_CODES` enum, `AppError` class, factory helpers (`unauthenticated`, `forbidden`, `notFound`, `validationFailed`, `signatureInvalid`, `conflict`, `featureNotEnabled`), and `toErrorResponse`.
- `src/server/http/route.ts` — `route()` wrapper, `jsonBody`, `parseBody`, `ok`, `created`, `noContent`, query helpers; centralizes request-id propagation and error serialization.
- `src/server/integrations/provider-error.ts` — `ProviderError` with `code` + `retryable`.
- `src/app/(dashboard)/error.tsx` — Segment-level error boundary.
- `src/app/global-error.tsx` — Root-level fallback boundary.
- `src/app/not-found.tsx` — 404 page.

## Architecture and Conventions

### Error types and codes

`ERROR_CODES` is an `as const` object whose keys form the `ErrorCode` type. Every application error maps to one of these codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `PROPOSAL_VERSION_CONFLICT`, `PROPOSAL_NOT_REVIEWABLE`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENT_REQUEST_IN_PROGRESS`, `RECORD_VERSION_CONFLICT`, `RECORD_NOT_POSTED`, `OBLIGATION_HAS_PAYMENTS`, `SIGNATURE_INVALID`, `WEBHOOK_REPLAYED`, `FEATURE_NOT_ENABLED`, `RATE_LIMITED`, `EXPORT_IN_PROGRESS`, `INTEGRATION_NOT_CONNECTED`, `INTERNAL`. New domain failures add a new code rather than reusing existing ones.

`AppErrorDetails` is typed as `Record<string, string | number | boolean | readonly string[] | null>` — only JSON-safe primitives are allowed so details can be serialized into the response body without leaking stacks or sensitive values.

### Throwing convention

Business logic throws `AppError` directly via the factory helpers (e.g. `throw new AppError(429, ERROR_CODES.RATE_LIMITED, ...)` in auth routes). The `http/route.ts` wrapper catches `AppError` instances and returns their status/code/message/details verbatim. Unexpected errors (anything not an `AppError`) are logged at `http.unhandled_error` and returned as `500 INTERNAL` with a sanitized message — no stack trace or original message reaches the client.

Zod validation errors are caught specially: they become `422 VALIDATION_FAILED` with a flattened `{ fields: [...] }` detail array.

### Request correlation

Every route goes through `requestIdFrom(request)`, which reads `x-request-id` or `x-correlation-id` headers and falls back to `crypto.randomUUID()`. The same ID is attached to every outgoing response header (`x-request-id`) and embedded in the error body's `requestId` field, so server logs and client responses are correlatable.

### Provider error contract

External adapters throw `ProviderError(code, message, retryable)`. The `retryable` flag is the only cross-cutting concern the caller needs to understand — it lets the job runner distinguish transient failures (e.g. `extraction_unavailable`, `speech_unavailable`, `media_download_failed`) from permanent ones (e.g. `extraction_auth_failed`, `audio_too_long`, `empty_transcript`).

### Client-side presentation

- `src/app/(dashboard)/error.tsx` is a React error boundary for the dashboard segment. It deliberately does not echo `error.message` to the merchant; instead it renders localized strings (`app.errorTitle`, `app.errorBody`) and shows the `error.digest` for support reference.
- `src/app/global-error.tsx` is the last-resort boundary that replaces the root layout when everything else fails; it is self-contained (inline styles, no global CSS import) because the broken layout is what caused the failure.
- `src/app/not-found.tsx` renders a localized 404 page.

### Security constraint

The comment on `src/lib/errors.ts` states the invariant: "Errors never carry stack traces, provider payloads, transcript text or sensitive values to the client." The `toErrorResponse` helper enforces this by returning only `code`, `message`, `requestId`, and `details` for `AppError`, and a generic `INTERNAL` message for unknown errors.

## Conventions and Constraints

- **Throw `AppError` from business logic**, not raw `Error` or `Response` objects — enforced by the `route()` wrapper which treats any non-`AppError` as an unhandled internal error.
- **Use the factory helpers** (`unauthenticated`, `forbidden`, `notFound`, `validationFailed`, `signatureInvalid`, `conflict`, `featureNotEnabled`) rather than constructing `AppError` manually — observed across all route files.
- **Add new domain failures as new entries in `ERROR_CODES`** — the `ErrorCode` type is derived from this object, so adding a code is the only way to introduce a new error shape.
- **Never expose stack traces or raw messages to clients** — enforced by `route()`'s catch block and by the client error boundaries which render localized strings instead of echoing `error.message`.
- **Attach `x-request-id` to every response** — enforced by `route()`, which sets the header on both success and error paths.
- **Integration adapters throw `ProviderError` with a descriptive `code` and a correct `retryable` flag** — observed in OpenAI speech/extraction, Twilio WhatsApp, and mock adapters; the `retryable` flag is the contract consumed by the job runner.
- **Client error boundaries do not display raw error messages** — enforced by the comments and implementation in `src/app/(dashboard)/error.tsx` and `src/app/global-error.tsx`, which use localized UI strings and only show the digest/reference id.