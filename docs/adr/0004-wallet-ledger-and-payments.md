# ADR 0004: Wallet ledger, Stripe payments, reports and reconciliation (Phase 5)

- **Status:** Accepted
- **Date:** 2026-11-24

## The ledger is the only way money moves
- **One service.** `LedgerService` is the only code that writes `wallet_transactions`, `debts`, `debt_settlements` or wallet totals. Routes, the Stripe webhook and (from Phase 6) attendance finalization all call it.
- **Every operation is one database transaction (READ COMMITTED, 30 s timeout).** Each transaction:
  1. locks the wallet row with `SELECT … FOR UPDATE`;
  2. checks the idempotency key (a replay returns the stored result and posts nothing);
  3. computes the change with pure functions (`domain/ledger-math.ts`);
  4. appends rows with the next gap-free `sequence`;
  5. writes the audit entry and the in-app notification;
  6. updates the cached wallet totals.
- **Each row stores `walletDelta`, `debtDelta` and the before and after values of both.** The database checks that before + delta = after, and that no balance or debt goes below zero. The append-only trigger rejects any `UPDATE` or `DELETE`. Amounts are integers in minor units, and every row's amount is positive (`wt_amount_positive`).
- **Idempotency keys are namespaced by operation and actor:**

  | Operation | Key |
  | --- | --- |
  | Cash | `cash:<admin>:<client key>` |
  | Adjustments | `adjust:<admin>:<client key>` |
  | Cash refunds | `refund:<admin>:<client key>` |
  | Reversals | `reversal:<transaction>` (each entry can be reversed at most once) |
  | Stripe | the Stripe object id (`stripe_refund:<re_…>`, `stripe_dispute_won:<dp_…>`, …) |

  On top of this, the HTTP layer requires an `Idempotency-Key` header on every admin money write.

## Debt (D16, D18)
- **A charge spends the wallet first.** Any shortfall becomes a `Debt` linked to that charge. This is the €10 / €6 example: €6 is paid, €4 becomes debt.
- **Every credit settles open debts FIFO, oldest first.** This applies to cash, online top-ups, credit adjustments, reversal credits and won chargebacks. Each settlement posts a `DEBT_PAYMENT` row and a `DebtSettlement` record. The invariant `original = Σ settlements + outstanding` is checked nightly.
- **Waivers** (D19, always with a reason) reduce debt oldest first. A debt reduced to zero this way is marked `CANCELLED`, never `SETTLED`.
- **Money leaving through Stripe cannot be refused.** This covers card refunds after spending and chargebacks. The wallet pays what it can, and the rest becomes a `TOP_UP_REVERSAL` debt (D18).
- **As a result, a wallet never has a positive balance and open debt at the same time.** The simulation asserts this.

## Reversals
- **Financial rows are never edited.** A wrong entry gets a `REVERSAL` row that points to it.
- **What can be reversed directly:** cash top-ups, credit and debit adjustments, and cash refunds.
  - Undoing a credit that was already spent turns the missing part into debt.
  - Undoing a debit credits the money back, which settles debts first.
- **Online top-ups** are undone by refunding them to the card, so Stripe stays the source of truth.
- **Debt waivers** cannot be reversed.
- **Training charges** are reversed through `reverseTrainingCharge`, which attendance corrections call in Phase 6.
  - It returns what the user actually paid: what the wallet paid at charge time, plus later debt payments.
  - It does not return parts that were waived.
  - It cancels whatever is still owed.
  - Edge case, found by the simulation: if nothing was paid and the debt was fully waived, no money moves. The charge is marked `REVERSED` without a ledger row, and the reconciliation check allows that case.

## Stripe top-ups
- **Creating a top-up only creates a PaymentIntent.**
  - The checks: email verified, amount between the min and max settings, and the result stays under the wallet cap.
  - A Payment row is unique per (user, client idempotency key). The Stripe idempotency key is `topup:<payment id>`.
  - **The wallet is credited only from a verified webhook** (or from the sweeper, which re-reads the intent from Stripe). The app's "success" screen never moves money.
- **The webhook verifies the signature against the raw body.** Each event is stored once in `stripe_events`. That row is locked while the event is processed, so concurrent duplicates wait and are then acknowledged. A failure is recorded on the event and returns 500, so Stripe retries. The webhook sits behind the View-as guard like every other route.
- **The payment state machine only moves forward.** A late `processing` event never undoes `succeeded`.
- **A succeeded intent whose amount or currency differs from the Payment becomes `REQUIRES_REVIEW` and is not credited.** It is logged at error level and shown on the dashboard.
- **Card refunds** (admin only, D17) are limited to the payment's refundable amount and the current balance. Stripe is called first, with an idempotency key per admin and request. The ledger row is then keyed on the refund id, so a retry after a crash posts it exactly once. `refund.updated` and `refund.failed` keep the Payment in step; a failed refund credits the money back.
- **Disputes:** `charge.dispute.created` debits the wallet (D18) and marks the Payment `DISPUTED`. A dispute that closes as `won` credits the money back, which settles debt first.
- **The sweeper** runs in the worker every 5 minutes. It re-reads payments still unresolved after 15 minutes. After 24 hours it cancels the intent and marks the payment `CANCELED`.
- **Configuration:** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET` must be set together. They are required when deployed, and production refuses `sk_test_` keys. If they are missing locally, top-ups return `PAYMENTS_UNAVAILABLE` and cash keeps working. `STRIPE_API_URL` (stripe-mock) is allowed only locally.

## Reports (D20)
- **Training revenue is reported as charged, collected and outstanding.** Collected means paid from the wallet at charge time plus later debt payments; outstanding means open debt. Top-ups are shown as wallet funding, not revenue.
- **Periods follow the Europe/Amsterdam calendar.**
  - The default period is the current month; the maximum is 3 years.
  - Revenue buckets are formatted in SQL with `to_char`, so the Node process timezone cannot shift them.
- **CSV exports** (revenue, debt per user, cash per admin, and the full ledger for the accountant) are UTF-8 with a BOM and CRLF line endings. Amounts are decimal strings. Text cells that a spreadsheet would run as a formula get an apostrophe in front (OWASP CSV injection). Negative amounts stay numeric.

## Reconciliation
- **Each check recomputes a figure from the immutable ledger and compares it with what is stored:**
  - wallet totals and sequence vs. the sum of deltas and the row count;
  - a gap-free before/after chain;
  - wallet debt vs. open debts;
  - for each debt, original = settlements + outstanding;
  - each successful Payment credited exactly once;
  - charges vs. ledger rows;
  - charge status vs. reversal rows.
- **It runs** when the worker starts, every 24 hours, and on demand (`POST /admin/reconciliation/run`, which is audited). The last report is stored and shown on the dashboard.
- **It never corrects anything.** A mismatch logs `RECONCILIATION MISMATCH` at error level. A human investigates and posts an adjustment with a reason.

## Phase gate: randomized simulation
- **What it is:** `test/ledger-simulation.ts` draws a reproducible stream of mixed operations from a seeded PRNG and runs them with 10–32 concurrent workers over a few wallets.
  - Operations: cash, replayed cash requests, credit and debit adjustments, waivers, charges (including free ones), reversals, charge reversals, cash refunds, online top-ups (some failing first, with webhooks delivered 1–3 times concurrently), card refunds, and disputes won or lost.
  - Phases alternate between "rich" and "poor", so wallets keep swinging between credit and debt.
- **Pass criteria:**
  - Business rejections (insufficient balance, already reversed, …) are counted; any other error fails the run.
  - Replays must return the original transaction.
  - Wallet invariants must hold.
  - Reconciliation must report zero issues.
- **Where it runs:**
  - CI runs two 1,500-operation seeds as an integration test.
  - The gate runs with `pnpm --filter @tw/api simulate:ledger -- --ops 10000 --seed <n>` against its own throwaway PostgreSQL.
  - 2026-11-24: seeds 20261124, 7 and 99 passed, with 20/10/5 wallets at concurrency 16/24/32. Each run posted about 11,500 ledger rows, and every reconciliation found 0 issues. The first run of seed 7 found the zero-amount charge-reversal bug described above. It is fixed and covered by a regression test.
