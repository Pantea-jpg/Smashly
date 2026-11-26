# ADR 0008: Testing and optimization (Phase 9)

- **Status:** Accepted
- **Date:** 2026-11-25
- **Details:** [06 Security review](../06-security-review.md) · [07 Performance review](../07-performance.md)

## Coverage floors are enforced in CI

- `pnpm test` runs the API, `@tw/money` and the mobile app with coverage. Vitest or Jest fails the run when coverage drops below a floor (`apps/api/vitest.config.ts`, `packages/money/vitest.config.ts`, the `jest` block in `apps/mobile/package.json`).

| Scope | Floor (lines) | Measured |
|---|---|---|
| Money domain: `modules/wallets/**`, `modules/payments/**`, `attendance.service.ts`, `trainings/domain/**`, `integrations/payments/**` | 95% | 98.8% |
| `@tw/money` (money arithmetic and formatting) | 95% | 100% |
| Every other `*.service.ts` | 85% | 98.2% |
| API overall (lines / branches) | 80% / 70% | 96.4% / 84.0% |
| Mobile app (lines / statements) | 80% / 80% | 83.1% / 81.1% (was 73.2%) |

- **Excluded:** generated Prisma code, plus `main.ts` and `worker.ts`, which only wire dependencies together and are exercised when the processes start.
- **Floors are the roadmap targets,** not today's numbers. Measured coverage sits above them, so a refactor has room, but a real drop fails CI.

## Tests added in Phase 9

| File | What it adds |
|---|---|
| `payments/payments-edge.int.test.ts` | 18 financial edge cases: failed refunds reported twice, at once or out of order; chargebacks won twice or lost after spending; unmatched events; stored errors and retries; intent states; simultaneous successes; sweeper resilience; idempotency across wallets. Every test ends with reconciliation. |
| `integrations/payments/payment-provider.test.ts` | The real Stripe SDK against a local stand-in server: request bodies, idempotency headers, response mapping, Stripe errors, webhook signatures. |
| `auth/auth-fuzz.int.test.ts` | Property-based fuzzing (fast-check) of tokens and public auth endpoints, plus forged-token cases. |
| `auth/auth.int.test.ts` (extended) | Per-account and per-IP login failure limits, and `Cache-Control: no-store` on every response. |
| `core/outbox/outbox.test.ts` | The worker's polling loop: draining, waiting, errors, stop. |
| `perf/query-performance.int.test.ts` | N+1 detection, `EXPLAIN ANALYZE` on every endpoint's SQL on a large club, foreign-key index coverage. |
| `packages/money` (extended) | Comparisons, signs, currency-mismatch guards. |
| `mobile/src/shared/ui/ListScreen.test.tsx` | List virtualization: a 500-row history mounts only the first screenful. |
| `mobile` member, admin and auth tests (extended) | Member wallet and transaction detail; admin adjustments (with a server refusal), reversals and the finance overview; forgot password, and the reset and verify-email links opened from email. 13 new app tests. |

## Bugs found and fixed

1. **A failed refund reduced the payment's refunded amount twice.** Stripe sends `refund.failed` and `refund.updated` for one failure. The ledger credit was idempotent, but the payment update ran on both.
   - **Fix:** `LedgerService.creditSystem` now returns `{ result, created }`, like `debitExternal`, and the payment is only adjusted when `created`.
   - **Also fixed:** that credit was labelled "Chargeback reversed". It now carries its own description ("Card refund failed").
2. **A late "pending" event could debit a refund that had already failed.**
   - **Fix:** before debiting, `refundKnownFailed` checks the stored Stripe events for a final `failed` or `canceled` state of that refund.
   - **Locking:** refund and dispute handlers lock the payment row first. Concurrent events about one payment are serialized, always in the order payment, then wallet, so they cannot deadlock.
   - **Proof:** with either fix removed, its test fails.
3. **A signed token with a non-UUID subject returned 500 instead of 401** (found by fuzzing). The token service now validates the subject.

## Security changes

- **`effect` pinned** to 3.22.5 through a pnpm override (high-severity advisory in a Prisma CLI dependency).
- **`Cache-Control: no-store`** on every API response.
- **Login limits:** a per-email failure limit (10 per 15 minutes) and a per-IP failure limit (30 per 15 minutes) are added on top of the per-IP+email limit. Successful sign-ins do not count.
- **Socket.IO** inbound frames are capped at 16 KB.

## Performance changes

- **Migration `20261125090000_phase9_indexes`:**
  - a ledger index on `created_at DESC, sequence DESC`: the admin ledger list went from 45 to 7 ms, and the dashboard from 55 to 4 ms on 50,000 rows;
  - a payments `created_at DESC` index;
  - indexes for 10 foreign keys that had none.
- **Mobile:**
  - React Compiler enabled (`experiments.reactCompiler`);
  - `ListScreen` virtualization tuned.
- **Not done, on purpose:** splitting the bundle per role, or lazy screens. The bundle is Hermes bytecode (4.1 MB), so startup cost has to be measured on a device first (Phase 10) before adding that complexity.

## Maestro

- **Flows:** six flows in `apps/mobile/.maestro` (sign in and wallet history, reserve a training, language switch, admin cash payment, admin finalize, and a Stripe test-mode top-up).
- **Selectors:** tab buttons got stable `testID`s (`tab-wallet`, …) so flows do not depend on the language.
- **Not run yet:** they need macOS with a simulator build. The first run is part of the Phase 10 device checks.

## Consequences

- Coverage slows the test run by roughly 10%.
- **Fixed along the way:** two app test files used Jest's default 5-second limit and timed out on a cold cache, which is what CI always has. All app tests now have a 20-second limit, and a cold-cache run passes.
- **New requirements:**
  - a money-moving change now needs tests for the edge cases it touches, or CI fails on the floor;
  - an endpoint added without an index, or with an N+1, fails the performance test if it is added to the endpoint list there. The list must be kept up to date when routes are added.
