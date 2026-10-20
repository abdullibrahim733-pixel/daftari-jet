---
kind: business_term
name: Business Glossary
category: business_term
scope:
    - '**'
---

### Daftari
- Definition：The product name for the voice-first, WhatsApp-native AI bookkeeper aimed at small businesses in Tanzania; the codebase implements the Daftari Dashboard web application.

### deni
- Definition：Internal term for customer debts / outstanding balances. The dashboard includes a dedicated Deni section showing total outstanding, overdue amounts, customer balances, payment history, and manual payment entry.
- Aliases：debts

### proposal
- Definition：An AI-generated, unconfirmed bookkeeping record created from a transcript or message. Proposals sit in the review inbox and require human confirmation, correction, or rejection before becoming part of the confirmed ledger.

### confirmed record
- Definition：A business event that has been reviewed, corrected if needed, and confirmed by an authorized user; only confirmed records contribute to Overview totals, Reports, and the Records ledger.

### correction / reversal
- Definition：A non-destructive amendment to an already confirmed record. Corrections preserve before/after values, actor, timestamp, reason, and source lineage; there is no normal delete action for financial history.

### source
- Definition：The original artifact that triggered a proposal — a WhatsApp voice note, text message, manual entry, or import. Every proposal and confirmed record links back to its source for auditability.

### TZS shillings x100
- Definition：The monetary unit convention used by the OpenAI extraction prompt: money is returned as integer minor units where 1 unit = one-hundredth of a Tanzanian shilling (two decimal places).
- Aliases：minor units
