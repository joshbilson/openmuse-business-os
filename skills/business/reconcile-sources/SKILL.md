---
name: business-reconcile-sources
description: Compare payment, bank and accounting records without treating a possible match as proof of settlement.
---

Collect verified Square payments, Revolut transactions, and Xero bank transactions for a clearly stated date range. Record each source's identity, update time, status and currency. Compare potential matches by amount, currency, event timing and available references. Keep each original record and its provider URL or ID in the review output.

Classify a pair as `candidate`, `confirmed_by_source_reference`, or `unmatched`. Only the provider's explicit shared reference or an owner-confirmed link may move a candidate to confirmed. Do not infer that a card tender, a payout and a bank receipt are the same transaction merely because the amounts resemble one another. Report reversals, refunds, fees, pending states and multi-leg transfers separately. If any source is missing, has more pages, or is stale, mark the comparison incomplete. This skill produces an analysis and suggested follow-up; it makes no accounting or banking mutation.
