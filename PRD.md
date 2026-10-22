# SAHL — Product Requirements Document

**Status:** Implementation specification  
**Product:** SAHL
**Surface:** SAHL merchant apps — Expo/React Native (iOS, Android) and the Next.js web app, sharing one backend
**Audience:** Product, design, engineering, QA, and AI coding agents  
**Initial market:** Small businesses in Tanzania  
**Document rule:** This document defines the user-visible product. `architecture.md` defines the implementation shape.

## 1. Product summary

SAHL is a Swahili-first AI business assistant for Tanzanian small businesses. A merchant records a voice note in SAHL on the web or a supported mobile client. SAHL transcribes it, interprets likely business events, and creates proposed records. The merchant reviews, corrects, and confirms them, and confirmed records become a useful view of sales, expenses, cash flow, inventory, and customer debts (deni).

**Direction update:** In-app AI capture is the primary recording channel. WhatsApp capture is **deferred**: it is off by default, not part of the first release, and must be separately prioritized and security-reviewed before re-enabling. Existing WhatsApp requirements elsewhere in this document describe the deferred channel and do not gate the first release.

**Primary experience:** after onboarding, the first screen is **Record**; **Reports** is second in navigation. Review, Records, Deni, Inventory, and Settings follow, or live under “More” on small screens. Microphone permission is requested when the user first taps Record, not at signup. “Start recording within 30 seconds of opening the app” is an activation target to measure with real users and devices, not a promise.

Native mobile clients use the same authenticated HTTP APIs as the web app and never access the database directly. Mobile sessions use a bearer-token contract stored in iOS Keychain / Android Keystore, with server-side validation and revocation.

### Product promise

**Business made simple. Sema kilichotokea. Fahamu biashara yako.**

SAHL reduces the bookkeeping work between serving customers and understanding how the business is doing. It should feel clear and approachable to a merchant who does not use accounting software today.

## 2. Problem and product principles

### Customer problem

Many small merchants keep business knowledge across memory, paper notebooks, messages, and mobile-money notifications. Records may be incomplete, difficult to reconcile, or unavailable when the owner needs to answer questions such as “How much did I sell today?”, “Who still owes me?”, or “What stock is running low?” A conventional accounting workflow can require too much typing and accounting knowledge.

### Product principles

1. **Voice-first, capture-first.** Recording in the SAHL app (mobile or web) is the default; WhatsApp is deferred. The app also provides review, correction, reporting, and administration.
2. **Human confirmation for money records.** AI extraction creates a proposal. It never silently posts or alters a sale, expense, payment, debt, or stock movement.
3. **Show the source.** Every proposal and confirmed record links back to its source message, transcript, import, or manual entry.
4. **Plain language.** Prefer merchant language (“Sales”, “Money in”, “People who owe you”) over accounting jargon. Provide English and Swahili-ready copy; do not machine-translate financial meaning without review.
5. **Make uncertainty actionable.** Identify missing or ambiguous fields and ask one focused question at a time.
6. **Useful on a phone.** The dashboard is responsive and works on low-bandwidth connections, while retaining an efficient desktop review workflow.
7. **Respect privacy and local context.** Minimize collected data, make consent and retention understandable, and format dates, numbers, and TZS for Tanzania.

## 3. Goals, non-goals, and success

### Goals

- Give a merchant a trustworthy overview of confirmed business activity.
- Turn in-app voice recordings (and, later, WhatsApp messages) into reviewable proposed records.
- Let authorized users correct, confirm, reject, and explain proposals.
- Keep a durable, attributable history of source, model proposal, human changes, and final decision.
- Surface simple insights from confirmed records without claiming certainty the data does not support.
- Support one merchant with one or more businesses and multiple invited team members.

### Non-goals for the first release

- Replacing a full accounting, tax filing, payroll, or statutory reporting system.
- Automatically initiating payments, collecting money, or making lending/credit decisions.
- Treating an AI guess as a verified transaction or bank/mobile-money settlement.
- WhatsApp capture in the first release (deferred).
- Direct database access from mobile clients, or WebView-wrapped web UI as the mobile app.
- Supporting every business type, country, currency, payment provider, or language at launch.
- Full POS, invoicing, supplier procurement, or omnichannel commerce workflows.

### Product success measures

**North Star:** Weekly Confirmed Business Records per Active Business (WCBR). Count distinct records that a business confirms in a week, excluding duplicates, test records, and records later voided. Report the value with coverage and correction rates so high volume cannot hide poor quality.

Supporting metrics:

- **Activation:** percentage of onboarded businesses that confirm their first proposed record within 7 days (also measure time from app open to first recording; the 30-second target is a measurement, not a promise).
- **Time to value:** median time from the first inbound voice note to first confirmed record.
- **Review completion:** proposals confirmed, corrected, or rejected within 24 hours / all proposals created in that period.
- **Extraction quality:** field-level precision/recall on a consented, manually adjudicated evaluation set; slice by language, accent, record type, and audio quality.
- **Correction burden:** median number of edited fields per confirmed record and percentage of proposals requiring a material correction.
- **Trust:** source-linked record rate, unexplained ledger-change count (target zero), and merchant-reported confidence.
- **Retention:** active businesses with at least one confirmed record in a week, cohort retention, and paid retention when subscriptions launch.
- **Reliability:** successful inbound webhook processing, pipeline completion latency, and dashboard availability.

Do not set fabricated baseline targets. Establish baselines in a pilot, then agree on targets with the product owner.

## 4. Users, roles, and jobs

### Primary personas

**Owner-operator / merchant**  
Runs the shop, often serves customers directly, and wants to record activity without stopping to type. Needs the business picture and final authority over ledger changes.

**Bookkeeper / manager**  
Reviews records, corrects categories and customer details, follows up on missing information, and prepares routine summaries. Needs a clear queue and a defensible history.

**Staff member**  
May record business activity or view limited operational information. Should not receive owner-level financial access by default.

### Role capabilities

| Capability | Owner | Manager / bookkeeper | Staff |
|---|---:|---:|---:|
| View dashboard and confirmed records | Yes | Yes, within grant | Limited / configurable |
| Review, correct, confirm, reject proposals | Yes | Yes, within grant | No by default |
| Add manual record | Yes | If granted | If granted |
| Invite/remove users and assign roles | Yes | No by default | No |
| Change business settings and integrations | Yes | If granted | No |
| View/export sensitive reports | Yes | If granted | No by default |
| View audit history | Yes | If granted | No |

Permissions are enforced by the backend for every request; hiding a button is not authorization.

## 5. Information architecture and navigation

Persistent workspace selector at the top of the navigation selects the active business. The selected business is visible on every page. On desktop use a left navigation rail; on mobile use a compact top bar and bottom navigation for the highest-frequency areas, with the rest under “More”.

Primary navigation order (capture-first):

1. **Record** — the signed-in landing screen; record, upload status, retry.
2. **Reports** — confirmed-only period summaries and exports.
3. **Review** — inbox of proposed records requiring a decision.
4. **Records** — searchable, filterable confirmed ledger.
5. **Deni** — customer balances and payment history.
6. **Inventory** — stock and movement view, if enabled.
7. **Settings** — business profile, team, privacy, and preferences. (WhatsApp connection is hidden while the channel is deferred.)

On mobile, Record and Reports are the first bottom-navigation items; the rest may sit under “More”. The former Overview snapshot may become a section of Reports.

Global controls: date range, business switcher, notification indicator, help, account menu, and language selector (English / Kiswahili when translations are ready). A compact **Review N** badge appears only when actionable proposals exist.

### Capture lifecycle

record → upload (retryable by capture ID) → processing (transcribe, extract) → review → human confirmation. Recording and upload state stays visible on weak connections; a financial confirmation is never queued to execute silently later.

## 6. Screens and detailed requirements

### 6.1 Sign in and business onboarding

**Purpose:** Establish a secure account, business workspace, owner, preferred language, timezone, and currency, then take the owner straight to Record.

**Screen components:** SAHL / سهل brand lockup, concise benefit statement, phone/email authentication UI based on the chosen identity provider, privacy link, language control, progress indicator, and help link.

**Onboarding steps:**

1. Create/sign in to account and verify identity.
2. Create business: name, business type (free choice plus “Other”), optional location, timezone default `Africa/Dar_es_Salaam`, and currency default TZS.
3. Choose dashboard language and basic preferences.
4. Explain how voice recordings are processed (transcription, AI extraction, retention) and the human-confirmation rule. Do not request microphone access here; ask when the user first taps Record.
5. Invite team (skippable); explain roles.
6. Land on **Record** with a clear next step: record a short sales voice note.

**States:** initial, validation error, verification pending, and abandoned/resumable.

**Acceptance:** A new owner reaches Record with a business workspace and an empty ledger. Onboarding does not create fabricated financial records.

### 6.1a Record (landing screen)

**Purpose:** Capture a business event by voice with minimal steps. Signed-in users land here (`/` redirects to `/record`).

**Requirements:** one-handed start/stop/replay/submit; microphone permission requested on first Record tap with a clear denied-state explanation; visible upload and processing status (uploading, transcribing, drafting, ready for review, failed with retry); safe retry using the capture ID; draft links to Review for human confirmation. A recording is never posted to the ledger without confirmation.

### 6.2 Overview

**Purpose:** Answer “How is my business doing?” quickly, based on confirmed records only. Available at `/overview` from the secondary navigation; it is not the landing screen. Its content may later merge into Reports.

**Layout, top to bottom:**

1. Greeting, active business, selected date range (Today, 7 days, 30 days, custom), and timezone context.
2. Review attention card showing count of proposals needing review and oldest pending time; CTA “Review records”. Hide the card when no pending items, but retain a small success/clear state.
3. KPI cards: Sales received, Expenses, Net cash movement, Outstanding deni. Cards show period totals, comparison only when the previous period has adequate data, and a “How this is calculated” tooltip.
4. Cash activity chart with sales and expenses by day/week. Use accessible labels and a table/list fallback.
5. Recent confirmed records with type, date/time, description, amount, source badge, and status.
6. Helpful insight card only when supported by enough confirmed data. Include period and evidence (“Based on 18 confirmed records”).
7. Optional inventory/deni summary cards, hidden when the business has not enabled or used that feature.

**Rules:** Pending proposals are never included in confirmed totals. Refunds and voids use explicit treatment in calculation copy. Do not call net cash movement “profit”. Do not compare across periods with different coverage without explaining it.

**States:** first-use empty state with “Record a voice note to start”; loading skeleton; partial-data state; populated state; stale-data indicator; error state with retry; date range with no records. Data freshness must be visible when processing is delayed.

### 6.3 Review inbox

**Purpose:** Review AI proposals and resolve ambiguity safely.

**Queue tabs/filters:** Needs review, Missing details, Failed processing, Recently decided. Filters: record type, source, received date, confidence band (internal/advanced only), and assignee if assignments exist. Default sort: oldest actionable first, with newest activity clearly shown.

**Queue row/card:** source icon (in-app voice/manual/import; WhatsApp when re-enabled), sender/source label, received timestamp, detected record type, short transcript or message preview, proposed amount if present, missing-field indicator, processing status, and accessible actions: Open, Reject. Do not expose raw model confidence as a guarantee; use a simple “Check details” cue.

**Bulk actions:** none in MVP. A decision on one proposal must not accidentally confirm others.

**Queue states:** empty (include explanation and a Record shortcut), loading, loaded, no filter matches, partial pipeline errors, and stale. Pagination/infinite loading must preserve filter and scroll position where feasible.

### 6.4 Proposal review detail

**Purpose:** Let an authorized person compare the source and proposal, edit fields, and make a deliberate decision.

**Desktop layout:** source/transcript panel on the left, editable proposed-record form on the right, decision bar fixed at the bottom of the review panel. On mobile, source and form are stacked with a sticky decision bar that does not cover fields.

**Source panel:** recording playback (when retained and accessible), original message text, transcript with language label, sender/source/time, processing history, and source ID. Audio playback must have controls, duration, and a download option only if policy permits. Audio is private business data.

**Proposed fields by record type:**

- **Sale:** amount, currency, occurred-at date/time, customer (optional), items (optional), payment method/status, note, category.
- **Expense:** amount, currency, occurred-at date/time, payee/vendor (optional), category, payment method/status, note.
- **Debt/deni created:** customer, amount, due date (optional), related sale (optional), note.
- **Debt payment:** customer, amount paid, received-at, payment method/reference (optional), related debt if known.
- **Stock movement:** item, quantity and unit, movement type, optional cost, note. Only enable when inventory setup exists.
- **Business note / unknown:** transcript and editable note with “Save as note” or “Reject”; never force it into a money record.

All money fields use integer minor units in storage and TZS presentation where appropriate. Date/time uses the business timezone and remains editable. Required fields vary by record type and are validated inline.

**Actions:** “Confirm record”, “Reject”, and “Save changes” (where drafts are supported). Confirm action displays a summary of the exact effect, e.g., “Add TZS 15,000 sale to confirmed records”. Reject requires a reason selected from clear options or an optional explanation; it does not delete the source. If a proposal may be a duplicate, show the candidate and require explicit resolution.

**Concurrency:** If another user changes the proposal while it is open, show the newer version and ask the reviewer to reload or reconcile; never overwrite silently.

**States:** transcript pending, extraction pending, ready, needs clarification, failed, duplicate candidate, already decided, permission denied, optimistic-lock conflict, and saved/confirmed/rejected. If transcription is wrong, the user can edit it or mark it unusable; the original transcript and correction remain auditable.

### 6.5 Records ledger

**Purpose:** Browse the confirmed source of truth.

**Table columns:** occurred date, type, description, customer/payee, amount, payment status/method, source, last changed. On small screens render accessible cards. Tabs or filters for All, Sales, Expenses, Deni, Payments, Stock, and Notes as available.

**Search and filters:** text search over permitted business fields; date range; type; payment status; source; customer/payee. Filters are URL-addressable where practical and have a clear reset action.

**Record detail:** amount and effect, type-specific fields, source/transcript link, who confirmed, original proposed values, current values, correction history, related customer/debt/payment, and void/correction actions subject to permissions.

**Corrections:** Do not destructively edit financial history. Create a correction/reversal or versioned update with actor, timestamp, reason, before/after values, and source link. “Delete” is not a normal ledger action. Void/reverse requires a reason and confirmation.

### 6.6 Deni (debts)

**Purpose:** Help the owner see customer balances and payment history.

**Summary:** total outstanding, overdue total, customers with balances. Clearly state that values derive from confirmed records and may not equal settled bank/mobile-money balances.

**List:** customer, balance, oldest outstanding date, due/overdue state, last payment. Customer detail shows linked sales, debt entries, payments, corrections, and source evidence. Add payment manually only for users with permission and require confirmation. A reminder action may be shown only if an actual messaging integration and consent rules support it; MVP may instead provide a copyable reminder text.

**States:** no debts, no matching customers, overdue, partial payment, fully settled, disputed/needs correction, and stale data.

### 6.7 Inventory (feature-gated)

**Purpose:** Show stock on hand and movement history only when the business has configured items and units.

**Components:** stock summary, low-stock list when thresholds are supplied by the merchant, item list with unit, movement history, source-linked adjustment detail. AI-detected changes remain proposals until confirmed. Do not infer a stock count from an isolated sale unless item quantity/unit and mapping are clear.

### 6.8 Reports

**Purpose:** Provide understandable summaries from confirmed data.

**MVP reports:** sales and expense totals by date range; cash movement; unpaid/paid deni; activity by category; downloadable CSV for authorized roles. Each report shows inclusion rules, date range, timezone, generated-at time, and data completeness caveat. Do not label cash movement as accounting profit or tax-ready statements.

### 6.9 Settings

Sections: Business profile; language, currency, and timezone; team and roles; privacy/data controls; notification preferences; export; account/security; support. A WhatsApp connection section appears only when that channel is re-enabled.

If the WhatsApp channel is re-enabled, integration controls include connected/disconnected/error state, authorized phone identity, last webhook received, reconnect steps, and disconnect action. Do not show tokens or provider credentials.

Privacy controls make available product-defined retention options, export request, deletion request, consent status, and contact path. Deletion must follow the platform’s retention and legal requirements and must not promise immediate erasure when immutable audit/backup retention applies.

## 7. Core workflows

### Voice note to confirmed record

1. Merchant opens Record in the mobile or web app and records a voice note.
2. The app uploads it to the authenticated capture API with a client-generated capture ID; retries are idempotent. SAHL stores the source and an encrypted audio object according to retention policy.
3. The system acknowledges receipt promptly and queues processing.
4. Speech-to-text creates a transcript with language and quality metadata.
5. Extraction returns zero or more typed proposals with field provenance, confidence/uncertainty, and missing fields.
6. Business rules validate amounts, currency, dates, and relationships. Low-quality or ambiguous input goes to “Needs details” rather than being guessed into a ledger record.
7. Dashboard review queue updates. Merchant sees the source and editable proposal.
8. Merchant confirms, corrects and confirms, rejects, or marks as a note. Confirmation atomically creates the ledger record and audit event; rejection preserves the source and reason.
9. Overview and reports recalculate from confirmed ledger records; proposals do not contribute.

### Correct a confirmed record

1. User with permission opens record and chooses “Correct” or “Reverse”.
2. UI explains effect and requires a reason.
3. Backend verifies tenant, permission, current version, and valid relationship.
4. Backend writes a versioned correction/reversal plus audit event in one transaction.
5. Derived totals refresh; prior version remains available to authorized users.

### Deferred: WhatsApp outage or missed processing

Applies only if the WhatsApp channel is re-enabled. Show connection health and the last received event. Queued events retry safely. A permanent failure appears in the review inbox with source and a retry/reprocess action where safe. Do not silently discard a message or claim it is recorded if only provider receipt, not processing, is known.

### Failed or delayed in-app capture

The app preserves the recording and shows a retryable status. A failed transcription or extraction appears in the review inbox with the source and a safe retry action. Never claim a recording is booked until a human confirms it.

## 8. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | A business owner can create a business workspace with Tanzania defaults and edit them. | P0 |
| FR-02 | Users can record in-app, see upload/processing status, and retry safely. (WhatsApp source visibility is deferred.) | P0 |
| FR-03 | Every inbound source event is deduplicated and linked to a processing job and source artifact. | P0 |
| FR-04 | Speech transcript and extraction proposal are visible in the dashboard with their processing state. | P0 |
| FR-05 | No AI-created financial record enters confirmed ledger without an authorized human confirmation. | P0 |
| FR-06 | Reviewers can edit proposed fields, confirm, reject with reason, and inspect source. | P0 |
| FR-07 | Confirmation is idempotent and creates record plus audit event atomically. | P0 |
| FR-08 | Overview/report totals use confirmed records only and disclose calculation rules. | P0 |
| FR-09 | Users can search/filter records and inspect source and correction history. | P0 |
| FR-10 | Tenant isolation and backend role enforcement cover every read/write/export. | P0 |
| FR-11 | User-visible loading, empty, stale, error, retry, and permission states are implemented. | P0 |
| FR-12 | Owner can invite/remove team members and assign supported roles. | P1 |
| FR-13 | User can inspect debts/deni and linked payments. | P1 |
| FR-14 | Authorized user can export a date-scoped CSV with an audit event. | P1 |
| FR-15 | Inventory view is available only when feature enabled and business setup is valid. | P2 |

## 9. Visual design and brand consistency

### Brand palette

| Token | Value | Use |
|---|---|---|
| Deep Navy | `#0D1B2A` | Primary text, navigation, strong headings, dark surfaces |
| Saffron Orange | `#FF8A00` | Primary action, selected navigation marker, focus accents, important highlights |
| Warm Ivory | `#FFF7E6` | Page background or warm branded surfaces |
| Success Green | `#23845B` (token; validate contrast before use) | Confirmed payment/success only |

Supporting neutrals should be derived as named tokens: white surface, subtle border, muted text, disabled surface, warning, danger, and chart colors. Do not use Saffron as a large body-text color on ivory unless contrast passes. Pair color with text/icon/state labels; never encode payment or error meaning with color alone.

### Design direction

Modern, calm, practical, warm, and trustworthy. Use generous whitespace, strong typographic hierarchy, restrained rounded cards, subtle borders, and clear tabular alignment for amounts. Use orange sparingly so primary actions stand out. Avoid generic financial SaaS neon gradients, excessive glass effects, ornamental charts, and stock-photo hero imagery in the working dashboard.

### Tokens and component rules

- Define colors, spacing, radii, typography, shadows, and z-index in one token source (CSS variables or theme file) and consume tokens in every component.
- Use a consistent spacing scale (4/8/12/16/24/32/48 px), consistent control heights, and one border-radius scale.
- Use tabular numerals for currency and aligned amounts.
- Standardize semantic badges: Pending, Confirmed, Rejected, Failed, Paid, Overdue. Labels must match underlying state.
- Buttons: one primary saffron action per decision area; secondary neutral; destructive red and explicit.
- Icons must have accessible names or be decorative with hidden labels.
- Use focus rings, keyboard navigation, minimum readable text size, and AA contrast targets. Verify contrast for final token combinations.
- Responsive breakpoints follow content needs; tables become cards or horizontal-scroll regions with accessible labels on narrow screens.

### Non-negotiable consistency rules

1. Use exact brand values above; do not invent alternate navy, orange, or ivory per screen.
2. Only confirmed records affect financial totals.
3. All financial values display currency and clear sign/context; store money as integer minor units.
4. Every proposed or confirmed record can be traced to its source or is explicitly marked manual.
5. Record is the primary capture surface in the apps; WhatsApp is deferred.
6. Never imply AI confidence equals truth or payment verification.
7. Never expose one business’s data to another business through UI, API, search, exports, caches, or logs.
8. Every state-changing financial action identifies the actor, time, reason where applicable, and prior values.
9. Use “profit” only when a specifically defined accounting calculation supports it; MVP uses “net cash movement”.
10. Prefer clear Swahili/English strings from localization files; do not hard-code interface copy inside components.

## 10. Accessibility, localization, and performance

- Target WCAG 2.2 AA for key flows; keyboard access and visible focus are required.
- Screen readers announce status changes (new proposal, save/confirmation, error) without moving focus unexpectedly.
- Charts have text summaries and a data-table alternative.
- Localize dates, numbers, and labels. Default timezone `Africa/Dar_es_Salaam`; default currency TZS. Do not assume the user’s language from their location.
- Support Swahili/English speech metadata and preserve original transcript; allow correction. Voice language can vary by speaker and utterance.
- Keep the first useful screen lightweight; paginate records, lazy-load audio, and avoid downloading original recordings until requested.
- Offline/poor network state must preserve unsaved form edits locally only for the active session and clearly show unsaved status; never queue a financial confirmation silently for later execution.

## 11. Analytics and privacy boundaries

Product analytics should use event names and properties from an approved schema and avoid raw transcript, audio, phone number, customer name, or amount unless explicitly required and approved. Suggested events: `business_created`, `capture_started`, `capture_uploaded`, `source_received`, `proposal_ready`, `proposal_opened`, `proposal_corrected`, `proposal_confirmed`, `proposal_rejected`, `record_corrected`, `export_requested`.

Access to audio/transcripts is sensitive and should be separately logged. Analytics opt-in, retention, and consent follow the applicable product policy. Never use a merchant’s private recordings to train general models without a separate valid legal basis and clear consent.

## 12. Acceptance criteria for release

1. Owner completes onboarding and lands on Record with an empty ledger.
2. An in-app voice recording produces a source-linked transcript and proposal, or a visible failure state with retry/escalation.
3. A reviewer can compare audio/transcript to proposed fields, correct them, and see the exact effect before confirmation.
4. A confirmed record appears in Records and appropriate Overview totals exactly once.
5. A rejected or pending proposal never changes any confirmed total.
6. Duplicate capture upload (same capture ID) or webhook delivery does not create a duplicate source, proposal, ledger record, or payment.
7. Unauthorized users cannot confirm, edit, export, or inspect protected records by direct API request.
8. A correction preserves before/after values, actor, timestamp, reason, and source lineage.
9. Currency/date math is correct for TZS, the business timezone, and date-range boundaries.
10. Empty, loading, error, stale, no-results, permission, conflict, and success states are covered for all P0 screens.
11. Core flows work with keyboard and screen reader announcements; contrast is verified.
12. Mobile layout supports review and correction without hidden fields or decision buttons covering content.
13. Logs and analytics contain no raw voice/transcript or secrets.

## 13. Recommended implementation sequence

1. Confirm stack/integration provider and business rules; create design tokens and localization shell.
2. Build identity, workspace/business switching, role guards, and onboarding shell.
3. Implement dashboard navigation, shared page states, data table/card components, and Overview from seeded development fixtures.
4. Implement source event, processing status, and proposal review UI against mocked API contracts.
5. Implement backend ingestion/transcription/extraction, source lineage, queue, and idempotency.
6. Connect review actions to atomic backend confirmation/rejection and audit events.
7. Implement confirmed Records, correction history, and Overview aggregation.
8. Add Deni and CSV reports; feature-gate Inventory.
9. Add operational dashboards, retention/export/deletion controls, accessibility and localization review.
10. Pilot with consented merchants; measure extraction corrections and workflow completion before broad rollout.

## 14. Open decisions to resolve before production

- Mobile session contract (bearer token issue/renew/revoke), supported recording formats, and upload duration/size caps.
- Whether the Expo app ships on both stores at launch, and the app-store privacy disclosures.
- WhatsApp Business API/provider, number ownership model, and template constraints (deferred until the channel is prioritized).
- Speech-to-text and extraction providers, supported languages, data residency/processing terms, and fallback model.
- Exact audio/transcript retention periods and deletion behavior, including provider copies and backups.
- Authentication provider, invitation lifecycle, and account recovery.
- Whether business can have multiple locations/branches in first release.
- Tax/accounting semantics and whether any export may be described as tax-ready.
- Payment verification source, if added; a voice statement alone is not settlement proof.
- Launch feature scope for inventory, manual entries, and multiple currencies.
