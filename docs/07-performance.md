# 07 — Performance review (Phase 9)

- **Date:** 2026-11-25
- **Result:**
  - no N+1 queries;
  - no avoidable full-table scans after the Phase 9 indexes;
  - every endpoint's slowest statement under 35 ms on a club 10× larger than expected at launch.

## How it is measured

`apps/api/src/perf/query-performance.int.test.ts` runs in CI against PostgreSQL 17 (Testcontainers).

1. **N+1 detection.** Every list, detail and report endpoint is called on a tiny club, then on a large one. The test counts the SQL statements each request sends (Prisma query events). A count that grows with the data is an N+1 and fails the test.
2. **Query plans.** On the large club, every SELECT an endpoint sent is re-run with `EXPLAIN ANALYZE`. The test fails when:
   - a statement takes more than 100 ms; or
   - a table with ≥ 10,000 rows is read sequentially under a `LIMIT` (a page should never read the whole table); or
   - a selective filter keeps less than 10% of the rows without an index.

   Whole-table aggregates (pagination totals, report sums) may scan, within the time limit.
3. **Foreign keys.** Every foreign-key column must lead an index (cheap joins, and cascading deletes that do not scan).

**Large club:**
- 2,000 members;
- 50,000 ledger rows (25 per member);
- 200 trainings with 8,000 responses and ~3,200 attendance rows;
- 40,000 notifications;
- 6,000 payments;
- 30,000 audit rows;
- 400 open debts.

Seeding with `generate_series` takes about 5 seconds, and the whole test about 30.

Run it locally and write the table below to a file:
```sh
cd apps/api
PERF_REPORT=perf.md pnpm exec vitest run --project integration src/perf
```

## Findings and fixes

| Finding | Before | After | Fix |
|---|---|---|---|
| Admin ledger list (`GET /admin/transactions`) read all 50,000 rows and sorted them to show 20 | 45 ms, seq scan | 7 ms (the remaining time is the total count) | index `wallet_transactions (created_at DESC, sequence DESC)` |
| Dashboard "recent activity" did the same | 55 ms, seq scan | 4 ms | same index |
| Admin payments list sorted all payments | 4.6 ms (6,000 rows), linear growth | 0.9 ms | index `payments (created_at DESC)` |
| 10 foreign keys without an index (deletes and joins scan) | — | all covered | `debt_settlements.transaction_id`, `debts.user_id`, `notification_deliveries.device_token_id` (device purge cascades), `payments.wallet_id`, `training_charges.attendance_id` / `wallet_id`, `training_price_overrides.user_id`, `trainings.created_by_id`, `wallet_transactions.payment_id` / `training_charge_id` |
| The new failed-refund check filtered Stripe events with `LIKE 'refund.%'` | — | uses the `(type, received_at)` index | `type IN ('refund.created', 'refund.updated', 'refund.failed')` |

All in migration `20261125090000_phase9_indexes`.
- At launch the tables are small, so plain `CREATE INDEX` inside the migration transaction is fine.
- If a future index is added to a large production table, create it `CONCURRENTLY` by hand first, and write that migration's statement as `CREATE INDEX IF NOT EXISTS`, so the deploy step finds it already there.

## Measured after the fixes (large club)

| Endpoint | SQL statements | Slowest statement (ms) | Avoidable full scans |
|---|---|---|---|
| `GET /me` | 3 | 0.1 | – |
| `GET /me/wallet` | 4 | 0.1 | – |
| `GET /me/transactions` | 3 | 0.2 | – |
| `GET /me/debts` | 3 | 0.1 | – |
| `GET /me/payments` | 2 | 0.1 | – |
| `GET /me/trainings` | 8 | 0.3 | – |
| `GET /me/trainings/:id` | 8 | 0.1 | – |
| `GET /me/notifications` | 2 | 0.2 | – |
| `GET /me/notifications/unread-count` | 2 | 0.1 | – |
| `GET /admin/dashboard` | 15 | 4.2 | – |
| `GET /admin/users` | 6 | 1.1 | – |
| `GET /admin/users?q=member12` | 6 | 7.8 | – |
| `GET /admin/users?hasDebt=true` | 6 | 1.8 | – |
| `GET /admin/users?sort=lastName` | 6 | 4.0 | – |
| `GET /admin/users/:id` | 4 | 0.1 | – |
| `GET /admin/users/:id/transactions` | 3 | 0.2 | – |
| `GET /admin/users/:id/debts` | 3 | 0.2 | – |
| `GET /admin/users/:id/payments` | 2 | 0.2 | – |
| `GET /admin/users/:id/trainings` | 9 | 0.7 | – |
| `GET /admin/wallets` | 6 | 1.9 | – |
| `GET /admin/transactions` | 5 | 6.9 | – |
| `GET /admin/payments` | 4 | 0.9 | – |
| `GET /admin/trainings` | 8 | 1.4 | – |
| `GET /admin/trainings/:id` | 7 | 1.2 | – |
| `GET /admin/trainings/:id/reservations` | 5 | 0.9 | – |
| `GET /admin/trainings/:id/attendance` | 9 | 0.2 | – |
| `GET /admin/attendance/queue` | 6 | 1.0 | – |
| `GET /admin/audit-logs` | 2 | 0.1 | – |
| `GET /admin/reports/summary?from=…&to=…` | 7 | 20.6 | – |
| `GET /admin/reports/revenue?from=…&to=…` | 2 | 32.7 | – |
| `GET /admin/reports/debts` | 3 | 1.9 | – |
| `GET /admin/reports/cash?from=…&to=…` | 2 | 22.2 | – |

"SQL statements" includes the per-request user check of `authenticate` and transaction framing. Timings are from a laptop running Docker; a managed database is usually faster.

## Known growth points (not problems at club scale)

- **Pagination totals** (`COUNT(*)` on the admin ledger list: 7 ms at 50,000 rows) grow linearly. At several hundred thousand rows:
  - switch the admin ledger list to cursor pagination, as the member history already uses; or
  - show "more than 10,000".
- **Report periods** (revenue, summary, cash) aggregate every row in the period, which is correct and stays fast while a period holds tens of thousands of rows. A monthly materialized summary is the next step if a club reaches millions.
- **Member search** (`q=`) runs ILIKE across email and names with OR over a join, so it scans users (8 ms at 2,000). The trigram indexes help once the search is split per table (UNION). Not needed below ~20,000 members.

## Mobile app

- **React Compiler on** (`experiments.reactCompiler` in `app.config.ts`).
  - Components and callbacks are memoized at build time, so list rows and cards do not re-render when unrelated state changes, for example a new page arriving or the unread badge changing.
  - The code already followed the compiler's rules (the `eslint-plugin-react-hooks` compiler rules run in CI).
  - The production iOS bundle was rebuilt and contains compiled components ("React Compiler enabled" in the export log).
- **Long lists** (`ListScreen`, used by every history and admin list):
  - FlatList virtualization tuned: 12 initial rows, batches of 10, a window of 9 screens instead of 21;
  - a test guards that a 500-row history mounts only the first screenful;
  - all lists are paginated (20 rows a page, cursor or offset) with infinite scroll.
- **Startup:**
  - the first frame waits only for persisted preferences (language, theme), not the network;
  - the session restore and all data load after the first render, behind skeletons;
  - the bundle is Hermes bytecode (4.1 MB), so no JavaScript parsing at launch.
- **Not measured here:** real startup time (TTI) and scrolling frame rate need a device. Measure on the Phase 10 TestFlight build with Xcode Instruments (Time Profiler, Hitches) and the React Native performance monitor. Targets:
  - cold start to the Home skeleton under 1.5 s on an iPhone 12;
  - no dropped frames while scrolling a 200-row history.
