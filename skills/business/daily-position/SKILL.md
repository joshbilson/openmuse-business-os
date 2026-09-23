---
name: business-daily-position
description: Summarize the latest available bank, accounting and point-of-sale facts with explicit source dates and gaps.
---

Read `business_capabilities` and `business_observation`. If a source is unconfigured, unverified, or stale, name it and exclude it from current totals. Refresh the relevant read capabilities one page at a time, following cursors only within the same connection. Use Revolut balances as balances, Square payments as tender activity, Xero bank transactions as ledger entries, and Xero `ACCPAY` bills / `ACCREC` invoices as obligations and receivables. These are different measures; never add them into one number or imply a Square payment has settled in the bank.

For each statement, include provider, source identity, currency, provider record ID, event time if present, and fetch time. Preserve the provider's signs and units. For bills and invoices, retain the Xero contact ID, due date, amount due, paid amount and status; do not assign a timezone to a Xero date string that lacks one. If a transaction has multiple currency legs or no amount, describe it without inventing a single value. State the period covered by each feed and any incomplete pagination. Finish with specific observations and open questions that the owner can verify in the source system. This skill only reads and reports; it does not send, pay, post, or edit records.
