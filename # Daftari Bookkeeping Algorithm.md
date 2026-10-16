# Daftari Bookkeeping Algorithm

**Version:** 1.0  
**Purpose:** An implementation-ready specification for a deterministic, no-AI-first bookkeeping engine that turns confirmed business events into a balanced ledger and a plain-language period-close report.

## 1. Product goal

Daftari helps a small-business owner record sales, expenses, customer debts (*deni*), supplier debts, payments, and cash movements; review incomplete items; close a selected period; and receive a concise report of what happened and what needs attention.

The bookkeeping core is deterministic. It does not need a language model, machine-learning classifier, or generated accounting judgment. Records enter through forms, explicit user choices, imports with mapped columns, or later speech transcription followed by structured user confirmation. Until a user confirms a proposed structured transaction, it is not posted to the ledger.

### Outcomes

- Every posted business event has an audit trail and balanced debit/credit entries.
- The owner can understand cash, sales, expenses, amounts owed, and period profit without navigating accounting jargon.
- A period cannot be marked closed while known blocking issues remain.
- Closing creates a reproducible snapshot. Corrections after close happen through an explicit, auditable adjustment or a controlled reopen.

### Non-goals for the first release

- AI-based categorization or automatic interpretation of free text.
- Tax filing, tax advice, statutory financial statements, or guaranteed compliance with a jurisdiction's accounting rules.
- Bank reconciliation integrations, payroll, inventory valuation, depreciation, accrual accounting, or multi-currency consolidation unless explicitly added as later modules.

## 2. Core design principles

1. **Deterministic:** The same confirmed inputs and configuration produce the same ledger and report.
2. **User-confirmed:** Ambiguous inputs are questions or drafts, never silent postings.
3. **Double-entry:** Each posted journal entry balances: total debits equal total credits.
4. **Immutable history:** Posted entries are corrected by reversal and replacement, not silently overwritten.
5. **Cash and profit are different:** The report labels cash movement separately from income, expenses, and profit.
6. **Explicit accounting policy:** Cash/accrual basis, opening balances, tax treatment, and inventory treatment are configuration choices, not hidden assumptions.
7. **Small-business language:** Present results in familiar terms, explain any exception, and show the underlying transactions on request.

## 3. Architecture

```text
User input (form / import / confirmed voice draft)
             |
             v
Validation and deterministic normalization
             |
             v
Business event + confirmation + audit record
             |
             v
Posting rules (event type + accounting policy)
             |
             v
Balanced journal entry (debits and credits)
             |
             v
Immutable ledger + derived account balances
             |
             v
Period-close checks -> close snapshot -> merchant report
```

### Components

- **Capture:** Collects a transaction through a typed form or an explicitly mapped import. A future voice feature may attach a transcript and create a draft, but a human must resolve required fields and confirm it.
- **Validation:** Checks required fields, valid dates, nonnegative amount, currency, account selection, duplicate warnings, and policy constraints.
- **Event service:** Stores the business event in its original form and its confirmation status.
- **Posting service:** Applies a versioned, deterministic rule for the event type and business configuration. It creates a journal entry atomically.
- **Ledger:** Stores immutable journal entries and lines, with tenant and source references. It is the accounting source of truth.
- **Close service:** Runs the checks in section 8, computes a period snapshot, and locks the period.
- **Report service:** Reads the snapshot and presents business-facing figures with drill-down to accounts and source transactions.

Posting, event confirmation, and audit-log creation must succeed or fail together in one database transaction. Use an idempotency key for retries so a repeated request cannot post twice.

## 4. Accounting policies and configuration

Store configuration per business and effective date. Record which configuration version was used to post each entry and close each period.

| Setting | MVP behavior | Decision owner |
|---|---|---|
| Functional currency | One currency per business; default may be TZS for a Tanzanian business, but never infer it silently | Merchant during setup |
| Bookkeeping basis | MVP supports cash basis for income/expense reporting; receivables/payables are still tracked as balances | Product/accounting review and merchant choice |
| Fiscal year | Calendar year by default; configurable start month | Merchant |
| Time zone | Business time zone; period boundaries are local dates, stored timestamps are UTC | Merchant/device setup |
| Tax | Store tax as a separate field/account only when the business enables a defined tax workflow; otherwise flag it as not handled | Merchant and qualified local adviser |
| Inventory | MVP tracks quantities only if needed for operational summaries; do not claim cost of goods sold or inventory valuation without a defined costing method | Product decision |
| Rounding | Store amounts as integer minor units; currency scale comes from currency metadata | Engineering configuration |
| Opening balances | Enter through a dated, balanced opening journal with source and review status | Merchant/bookkeeper |

**Important:** The default cash-basis treatment below is a product convention for an MVP, not a claim that it satisfies every business's accounting or tax obligations. Make the selected basis visible in settings and in every period report.

## 5. Transaction and ledger data model

Use decimal-safe amounts. Prefer integer minor units (`amount_minor`) for persisted money and calculations. Do not use binary floating-point for monetary arithmetic.

### Business event

```text
BusinessEvent
- id: UUID
- business_id: UUID
- type: SALE | EXPENSE | CUSTOMER_INVOICE | CUSTOMER_PAYMENT |
        SUPPLIER_BILL | SUPPLIER_PAYMENT | OWNER_CONTRIBUTION |
        OWNER_DRAW | TRANSFER | REFUND | OPENING_BALANCE | ADJUSTMENT
- occurred_at: timestamp (UTC)
- business_date: date in business time zone
- amount_minor: integer, positive
- currency: ISO currency code
- status: DRAFT | NEEDS_REVIEW | CONFIRMED | POSTED | VOIDED
- counterparty_id: UUID? (customer or supplier)
- description: string
- payment_method: CASH | MOBILE_MONEY | BANK | CREDIT | OTHER | UNKNOWN
- source: MANUAL | IMPORT | VOICE_CONFIRMED | SYSTEM
- source_reference: string? (recording, import row, receipt, external ID)
- category_id: UUID? (required for applicable event types)
- tax_amount_minor: integer? (only if tax workflow enabled)
- due_date: date? (credit sale/bill)
- related_event_id: UUID? (payment, refund, or reversal relationship)
- idempotency_key: string
- created_by: UUID
- confirmed_by: UUID?
- confirmed_at: timestamp?
- created_at / updated_at: timestamp
- posting_rule_version: string?
```

### Journal entry and line

```text
JournalEntry
- id: UUID
- business_id: UUID
- business_date: date
- period_id: UUID?
- source_event_id: UUID
- status: POSTED | REVERSED
- description: string
- reversal_of_entry_id: UUID?
- rule_version: string
- created_at: timestamp
- created_by: UUID | SYSTEM

JournalLine
- id: UUID
- journal_entry_id: UUID
- account_id: UUID
- debit_minor: integer (zero or positive)
- credit_minor: integer (zero or positive)
- counterparty_id: UUID?
- memo: string?
```

Each line must have exactly one nonzero side. Every journal entry must contain at least two lines, and `sum(debit_minor) == sum(credit_minor)`. Enforce these invariants in the posting service and database where feasible.

### Chart of accounts

Seed a small, editable chart of accounts. Store `code`, `name`, `type`, `normal_balance`, `is_system`, and `active`.

| Type | Example accounts |
|---|---|
| Asset | Cash on hand, Mobile money, Bank, Customer receivables |
| Liability | Supplier payables, Tax payable (only if configured) |
| Equity | Owner capital, Owner drawings, Opening balance equity |
| Income | Sales income, Other income, Sales returns |
| Expense | Stock purchases / cost of goods sold (depending on inventory policy), Rent, Transport, Wages, Utilities, Other expense |

Do not let the user delete system accounts with balances or posted history. Renaming a display label is allowed; changing an account's accounting type requires a controlled migration or a new account.

### Supporting records

- **Counterparty:** customer/supplier profile, contact details, opening balance, active flag.
- **Payment allocation:** links a payment to one or more invoices/bills; preserve unallocated balance as customer credit or supplier prepayment only under an explicit policy.
- **Period:** start date, end date, status (`OPEN`, `CLOSING`, `CLOSED`, `REOPENED`), closed-by, closed-at, snapshot ID, policy version.
- **Close snapshot:** immutable totals, check results, ledger watermark/version, and report-generation version.
- **Audit log:** actor, timestamp, action, object, before/after values where applicable, reason, and request ID. Never log secrets or unnecessary sensitive transcript content.

## 6. Deterministic posting rules

All examples use a single currency, positive amounts, no tax, and a cash-basis income/expense report. “Debit” and “credit” are ledger sides; the merchant UI should usually show plain-language labels.

### Cash sale

A merchant receives 50,000 in cash for a sale.

| Account | Debit | Credit |
|---|---:|---:|
| Cash on hand | 50,000 | 0 |
| Sales income | 0 | 50,000 |

### Sale received by mobile money

A merchant receives 24,000 through mobile money.

| Account | Debit | Credit |
|---|---:|---:|
| Mobile money | 24,000 | 0 |
| Sales income | 0 | 24,000 |

### Credit sale / customer owes the merchant

A merchant records a 75,000 sale to a customer who will pay later. Under an accrual posting policy:

| Account | Debit | Credit |
|---|---:|---:|
| Customer receivables | 75,000 | 0 |
| Sales income | 0 | 75,000 |

If the business is configured for cash-basis income reporting, the report must exclude unpaid sales from cash-basis recognized income until payment. The ledger can still track the receivable; the report must distinguish “sales recorded” from “cash-basis income recognized.” Do not count both the invoice and its later payment as income.

### Customer payment against an existing receivable

The customer pays 30,000 of the 75,000 debt in cash:

| Account | Debit | Credit |
|---|---:|---:|
| Cash on hand | 30,000 | 0 |
| Customer receivables | 0 | 30,000 |

The remaining receivable is 45,000. A payment is not a second sale.

### Expense paid immediately

The merchant pays 12,000 rent from cash:

| Account | Debit | Credit |
|---|---:|---:|
| Rent expense | 12,000 | 0 |
| Cash on hand | 0 | 12,000 |

### Supplier bill followed by payment

On receiving a 40,000 bill for transport services:

| Account | Debit | Credit |
|---|---:|---:|
| Transport expense | 40,000 | 0 |
| Supplier payables | 0 | 40,000 |

When 25,000 is paid later:

| Account | Debit | Credit |
|---|---:|---:|
| Supplier payables | 25,000 | 0 |
| Cash / selected payment account | 0 | 25,000 |

For cash-basis expense reporting, the report recognizes the expense when paid; for accrual reporting, it recognizes the bill date. Do not count the payment as a second expense.

### Owner contributes cash

Owner adds 100,000 of business capital:

| Account | Debit | Credit |
|---|---:|---:|
| Cash on hand | 100,000 | 0 |
| Owner capital | 0 | 100,000 |

This is not sales income.

### Owner withdraws cash

Owner takes 15,000 for personal use:

| Account | Debit | Credit |
|---|---:|---:|
| Owner drawings | 15,000 | 0 |
| Cash on hand | 0 | 15,000 |

This is not a business expense.

### Transfer between business money accounts

Transfer 20,000 from cash to mobile money:

| Account | Debit | Credit |
|---|---:|---:|
| Mobile money | 20,000 | 0 |
| Cash on hand | 0 | 20,000 |

A transfer is not income or expense.

### Refund

Refund a previously paid 5,000 sale. Create a linked reversal/refund event; do not delete the original sale. Simplest representation:

| Account | Debit | Credit |
|---|---:|---:|
| Sales returns (contra-income) | 5,000 | 0 |
| Cash / payment account | 0 | 5,000 |

If refunding a credit sale before collection, reverse the receivable instead of cash. The refund flow must ask which original sale/payment it relates to where possible.

### Voids and corrections

- An unposted draft may be edited or discarded, with an audit record where appropriate.
- A posted entry is never edited or deleted. Reverse the original entry and post a corrected replacement linked to it, with a required reason and actor.
- Disallow backdated posting into a closed period unless an authorized reopen workflow is used. Otherwise post an adjustment in the current open period with the original business date retained as a reference.

## 7. Calculation rules and formulas

Let `D(a, p)` be the total debits to account `a` in period `p`, and `C(a, p)` its total credits. For an account with a debit-normal balance:

```text
period_movement(a, p) = D(a, p) - C(a, p)
ending_balance(a, p) = opening_balance(a, p) + period_movement(a, p)
```

For a credit-normal account:

```text
period_movement(a, p) = C(a, p) - D(a, p)
ending_balance(a, p) = opening_balance(a, p) + period_movement(a, p)
```

Derived report metrics, after applying the configured basis:

```text
recognized_income = sum(income credits - income debits) for included events
recognized_expenses = sum(expense debits - expense credits) for included events
net_profit = recognized_income - recognized_expenses
cash_in = sum(debits to cash/bank/mobile-money accounts from external sources)
cash_out = sum(credits to cash/bank/mobile-money accounts to external destinations)
net_cash_movement = cash_in - cash_out
closing_cash = opening_cash + net_cash_movement
customer_amount_owed = ending debit balance of customer receivables
supplier_amount_owed = ending credit balance of supplier payables
```

Exclude internal transfers from aggregate cash-in and cash-out to prevent double counting. Include a refund as a reduction of income and a cash outflow. Owner contributions/drawings affect cash and equity but not profit. Make the exact basis and inclusion rules visible in the report details.

### Cash-basis report treatment

- A cash sale counts as income on its receipt date.
- A credit sale is shown in “sales recorded” and “customer debt,” but does not count as cash-basis recognized income until payment. Payment amounts are recognized as income up to the unpaid sale amount; excess is customer advance and needs explicit handling.
- An immediately paid expense counts as an expense on its payment date.
- An unpaid supplier bill is shown as “supplier amount owed,” but is not a cash-basis recognized expense until paid.
- Do not calculate inventory cost of goods sold from purchase cash payments unless the business's inventory accounting policy defines how. In the basic report, label the metric “cash paid for stock/purchases” if that is what is measured.

### Accrual basis (later or explicitly enabled)

- Recognize a sale on invoice/sale date, regardless of collection.
- Recognize an expense on bill/expense date, regardless of payment.
- Payments settle receivable/payable balances and do not create new income/expense.
- Require documented handling of tax, inventory, prepayments, and adjustments before describing output as a full accrual profit report.

### Periods

Periods use inclusive local business dates: `start_date <= business_date <= end_date`. Store UTC timestamps separately. A close must pin the business time zone, currency, selected basis, fiscal calendar, chart-of-accounts version, posting-rule version, and ledger watermark used for the report.

## 8. Book-closing workflow

1. Merchant chooses the period to close.
2. System lists drafts, incomplete transactions, unresolved duplicate warnings, unallocated payments, uncategorized applicable events, and unreconciled money-account differences if a statement/balance was entered.
3. Merchant resolves blockers or explicitly marks a permitted item as reviewed with a reason. Acknowledged warnings remain in the close report.
4. System validates all posted entries, including balanced debits and credits, valid accounts, correct tenant, valid currency, and no entries in the period that lack a source event.
5. System calculates totals and the selected accounting-policy report.
6. System shows a preview with drill-down and asks the merchant to confirm “Close books for this period.”
7. On confirmation, system writes an immutable close snapshot and transitions the period to `CLOSED` in a single transaction. Save user, timestamp, ledger watermark, policy versions, check results, and snapshot hash.
8. A later correction requires an authorized reopen (reason required) or a linked adjustment in an open period, based on product policy.

### Blocking checks

- Any confirmed event awaiting posting or failed posting.
- Any unbalanced journal entry.
- Any posted line pointing to an inactive/invalid account or another business.
- Missing currency/date/amount or invalid sign.
- A duplicate candidate that has not been resolved when its consequence could materially change totals.
- A material unallocated payment when the report cannot determine whether it is income or settlement.
- Negative cash balance, unless the merchant explicitly confirms it reflects a real overdraft/credit arrangement.
- Closed-period event mutation or backdated posting.

Warnings may include uncategorized optional expenses, missing receipt, unreconciled cash count, overdue customer debt, or late transaction entry. The product should explain what the warning means and how it affects the report.

## 9. Book-closing Python pseudocode

```python
from dataclasses import dataclass
from datetime import date
from typing import Iterable

@dataclass(frozen=True)
class CloseResult:
    period_id: str
    can_close: bool
    blockers: tuple[str, ...]
    warnings: tuple[str, ...]
    totals: dict[str, int]  # integer minor units


def entry_is_balanced(lines: Iterable[dict]) -> bool:
    lines = list(lines)
    if len(lines) < 2:
        return False
    for line in lines:
        debit = line["debit_minor"]
        credit = line["credit_minor"]
        if debit < 0 or credit < 0 or (debit > 0 and credit > 0):
            return False
    return sum(x["debit_minor"] for x in lines) == sum(
        x["credit_minor"] for x in lines
    )


def close_period(db, business_id: str, period_id: str, actor_id: str) -> CloseResult:
    # Run in a serializable transaction; lock the period row to prevent two closes.
    with db.transaction(isolation="serializable"):
        period = db.periods.lock_for_update(period_id, business_id)
        if period.status != "OPEN":
            raise ValueError("Only an open period can be closed")

        config = db.business_config.at_date(business_id, period.end_date)
        events = db.events.for_period(business_id, period.start_date, period.end_date)
        entries = db.journal_entries.for_period(business_id, period.start_date, period.end_date)

        blockers: list[str] = []
        warnings: list[str] = []

        for event in events:
            if event.status in {"DRAFT", "NEEDS_REVIEW"}:
                blockers.append(f"Event {event.id} needs review")
            elif event.status == "CONFIRMED" and not db.postings.exists_for(event.id):
                blockers.append(f"Event {event.id} is confirmed but not posted")

        for entry in entries:
            lines = db.journal_lines.for_entry(entry.id)
            if not entry_is_balanced(lines):
                blockers.append(f"Journal entry {entry.id} is unbalanced")
            if any(not db.accounts.belongs_to_business(x["account_id"], business_id)
                   for x in lines):
                blockers.append(f"Journal entry {entry.id} has an invalid account")

        blockers.extend(db.close_checks.duplicate_blockers(business_id, period_id))
        blockers.extend(db.close_checks.unallocated_payment_blockers(business_id, period_id))
        warnings.extend(db.close_checks.missing_receipt_warnings(business_id, period_id))
        warnings.extend(db.close_checks.overdue_debt_warnings(business_id, period_id))

        totals = compute_report_totals(
            entries=entries,
            events=events,
            accounts=db.accounts.for_business(business_id),
            basis=config.bookkeeping_basis,
            start_date=period.start_date,
            end_date=period.end_date,
        )

        if blockers:
            return CloseResult(period_id, False, tuple(blockers), tuple(warnings), totals)

        # Preview is normally returned before this function is called with confirm=True.
        # On confirmed close, persist snapshot and lock period atomically.
        snapshot = db.close_snapshots.create(
            business_id=business_id,
            period_id=period_id,
            actor_id=actor_id,
            totals=totals,
            warnings=warnings,
            basis=config.bookkeeping_basis,
            currency=config.currency,
            config_version=config.version,
            rules_version=POSTING_RULE_VERSION,
            ledger_watermark=db.ledger.current_watermark(business_id),
        )
        db.periods.mark_closed(period_id, actor_id, snapshot.id)
        db.audit_log.record(actor_id, "PERIOD_CLOSED", period_id, snapshot.id)

        return CloseResult(period_id, True, (), tuple(warnings), totals)
```

Production implementation must separate preview from confirmation, validate authorization and tenant ownership on every operation, and calculate totals from ledger lines rather than trusting client-submitted figures. The example emphasizes the algorithm; adapt transaction APIs and exception handling to the chosen stack.

## 10. Merchant report mockup

```markdown
# Daftari — Monthly business report

**Business:** Mama Asha Shop  
**Period:** 1–30 September 2026  
**Currency:** TZS  
**Method:** Cash basis  
**Status:** Closed on 2 October 2026

## Your month at a glance

- **Money received:** TZS 2,450,000
- **Money paid out:** TZS 1,620,000
- **Net cash movement:** TZS 830,000
- **Cash and mobile money at period end:** TZS 1,130,000

## Sales and costs

- **Cash-basis income:** TZS 2,200,000
- **Expenses paid:** TZS 1,120,000
- **Estimated operating profit:** TZS 1,080,000
- **Stock purchases paid:** TZS 500,000 (not treated as cost of goods sold)

## Money people owe you

- **Customer debt at period end:** TZS 340,000
- 3 customers have overdue balances

## Money you owe

- **Supplier bills outstanding:** TZS 210,000

## Check before next month

- 2 expenses have no receipt attached.
- Cash was not physically counted at month end; closing cash is calculated from recorded transactions.

## How these figures were calculated

This report uses cash-basis income and expense rules. Customer payments settle recorded debts and are not counted twice as sales. Owner contributions, withdrawals, and transfers are not included in profit. Stock purchases are shown as cash paid; inventory cost and gross profit are not calculated.

[View sales] [View expenses] [View customer debts] [Download report]
```

The values above are illustrative only. In the app, every total should open a filtered list of its source transactions. Label estimates and missing reconciliation evidence clearly; never present an inferred balance as a verified physical cash count.

## 11. MVP modules

1. **Business setup:** Currency, time zone, fiscal year, bookkeeping basis, payment accounts, starter chart of accounts.
2. **Transaction capture:** Sales, expenses, customer debts/payments, supplier bills/payments, owner contributions/drawings, transfers, refunds.
3. **Review queue:** Required-field validation, explicit category/account choice, duplicate warnings, receipt attachment, confirmation.
4. **Counterparties and balances:** Customer/supplier lists, payment allocation, due dates, overdue summaries.
5. **Posting and ledger:** Versioned rules, balanced journal entries, idempotency, reversal/correction flow, audit history.
6. **Dashboard:** Period-to-date cash received/paid, sales recorded, expenses, customer debt, supplier debt, recent activity, review items.
7. **Period close:** Checklist, blockers/warnings, preview, confirmation, immutable snapshot, authorized reopen/adjustment policy.
8. **Reports and export:** Merchant report, transaction drill-down, CSV export of events and ledger lines. Clearly identify basis and currency.
9. **Security and tenancy:** Authentication, business membership/roles, tenant-scoped access, encrypted transport and storage, backups, audit access.

### Suggested roles

- **Owner:** Configure books, confirm transactions, close/reopen periods, invite users.
- **Bookkeeper:** Enter/review records and prepare close; close permission configurable by owner.
- **Staff:** Create drafts and view permitted records; cannot alter accounting policy or close books.

## 12. Critical accounting and product decisions

Resolve and document these before presenting reports as accounting results:

1. **Cash or accrual basis:** Choose the MVP basis and encode treatment for unpaid sales/bills. Do not mix bases within a report.
2. **Credit sales and partial payments:** Define how invoices, payment allocations, overpayments, advances, write-offs, and refunds affect income and receivables.
3. **Supplier bills and partial payments:** Define bill recognition, payment allocations, prepayments, and expense categories.
4. **Inventory and cost of goods sold:** Decide whether stock is only operational tracking or valued inventory. Without a costing method and stock-count workflow, show purchase cash outflow rather than gross profit/COGS.
5. **Tax:** Determine whether tax is included in entered amounts, separate, payable, exempt, or out of scope. Obtain qualified local review before tax claims or filing features.
6. **Opening balances:** Define migration date, source, balancing account, review, and treatment of pre-existing debt and cash.
7. **Money account reconciliation:** Decide whether the merchant enters actual counted cash/mobile-money/bank balances and how variances are posted.
8. **Currency and rounding:** Define supported currency metadata, minor units, display formatting, and any future exchange-rate policy.
9. **Period corrections:** Define who can reopen a close, reason requirements, audit and notification behavior, and use of current-period adjustments.
10. **Negative balances:** Decide when cash below zero is a blocker, when it can represent an overdraft, and how the user records it.
11. **Duplicate detection:** Use deterministic heuristics (same business, date, amount, method, counterparty, and reference) only to raise a warning; never automatically delete or merge.
12. **Voice notes:** Store audio/transcript as source evidence under privacy policy. Any transcription or extraction creates a draft. Required fields and user confirmation are mandatory before posting.
13. **Report language:** Distinguish “money received,” “sales recorded,” “income recognized,” “profit,” and “cash balance.” Avoid using them interchangeably.
14. **Jurisdiction review:** Have the chart of accounts, tax treatment, statutory terminology, retention rules, and export reviewed for each launch market by a qualified local accounting professional.

## 13. Acceptance criteria

- Posting any supported event creates a balanced entry and a source link, or creates no posting at all.
- Repeating a confirmed posting request with the same idempotency key does not duplicate the ledger entry.
- Partial customer and supplier payments leave the correct remaining balance.
- Owner contributions/drawings and account transfers do not change profit.
- Reversals preserve the original record and explain the correction.
- A closed period cannot be silently changed; reopen or adjustment behavior is explicit and audited.
- A close preview reports all blockers and warnings before confirmation.
- A closed-period report can be regenerated from its snapshot and policy/version metadata.
- Each displayed total can be traced to its underlying account activity and source events.
- Incomplete or unconfirmed voice/import records never reach the posted ledger.
- Currency, date range, time zone, and accounting basis appear on every report.

## 14. Implementation notes

- Keep posting rules as pure functions where possible: input is a validated event plus policy version; output is a proposed balanced set of journal lines.
- Validate proposed lines before persistence; persist event status, journal entry, lines, and audit record atomically.
- Use database constraints for nonnegative line amounts, one-sided debit/credit lines, foreign keys, and tenant ownership where practical.
- Use integer minor units and currency-aware formatting. For ratios and percentages, use decimal arithmetic and explicit rounding.
- Use deterministic sorting and stable report definitions. Version report logic if its meaning changes.
- Maintain a test fixture set for each event type, partial payment, reversal, period boundary, duplicate warning, and closing blocker before release.
- Keep source documents and voice data access-limited, retention-aware, and separate from the ledger. Ledger descriptions should not contain sensitive unnecessary personal details.

---

**Accounting note:** This specification describes software behavior and bookkeeping workflows. It is not a substitute for accounting or tax advice. Confirm the chart of accounts, reporting basis, local tax rules, and statutory requirements with a qualified professional before relying on Daftari for formal accounts or filings.
