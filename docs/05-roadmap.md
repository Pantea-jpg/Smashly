# 05 — Development Roadmap

Status: **Draft for approval** · 2026-11-24

Each phase ends with a **gate**: tests green, docs updated, and a demo or review. Financial logic is never merged without tests.
Relative size: S / M / L.

> **One suggested change to the requested order:** build the mobile *foundation* (design system, navigation shell, auth screens) during Phases 3–4 instead of waiting for Phase 7. You get UX feedback early, and Phase 7 then wires screens to finished APIs. The backend phases are unchanged.

---

### Phase 1 — Product planning (this delivery) · S
- [x] Requirements analysis, risks, open decisions → `01-requirements-analysis.md`
- [x] System architecture, stack, folder structure → `02-architecture.md`
- [x] Database design + Prisma schema → `03-database.md`
- [x] API structure → `04-api.md`
- [x] Roadmap → this file
- **Approved 2026-11-24 with all default decisions.**
- **Gate:** you approve the architecture and schema and answer (or accept defaults for) the decisions marked ⛔ DB.

### Phase 2 — Project setup · S · ✅ done 2026-11-24
- pnpm monorepo: `apps/api`, `apps/mobile`, `packages/{contracts,money,i18n,config}`
- Shared strict TypeScript config, ESLint (incl. `i18next/no-literal-string`), Prettier
- API: Express 5 app factory, config/env validation (Zod), pino, error middleware, health endpoints
- Prisma + PostgreSQL 17 via `infra/docker-compose.yml` (Postgres, Redis, Mailpit, Stripe CLI)
- Expo app (development build), React Navigation shell, theme tokens, i18n bootstrap (en/nl)
- GitHub Actions CI: typecheck, lint, test, i18n key parity
- ADRs for the stack choices; exact versions pinned
- **Gate:** `pnpm dev` runs API + app against local Docker; CI is green.

### Phase 3 — Database and backend foundation · M · ✅ done 2026-11-24
- Final Prisma schema + first migration, with the raw SQL (CHECKs, triggers, partial index, trigram) and DB roles
- Seed script (first admin from env; demo data in non-prod only)
- Core: request context, response envelope, pagination and sorting helpers, AppError codes
- Auth: register, login, refresh rotation with reuse detection, logout / logout-all, password reset, email verification, Argon2id, rate limits
- RBAC middleware, ownership enforcement, audit writer, idempotency middleware, outbox table + dispatcher skeleton
- OpenAPI generation + Swagger UI
- *(parallel)* Mobile: design-system primitives, auth screens, secure token storage, refresh single-flight
- **Tests:** auth flows, token rotation and reuse, RBAC on every admin route, rate limits, validation
- **Gate:** a user and an admin can register/login on the app; admin routes reject users.
- **Result:** gate met for the API (verified end to end against Postgres, Valkey and Mailpit) and in the app's component tests. Not yet run on a physical iPhone or simulator. Decisions: [ADR 0002](adr/0002-auth-and-backend-foundation.md).
- **Carried into Phase 4:** profile language sync to the server (emails currently use the language chosen at registration), the admin approval UI for PENDING_APPROVAL accounts, tab icons.

### Phase 4 — User management · M · ✅ done 2026-11-24
- Admin user list (search with trigram, filters, pagination), user detail, activate/deactivate (revokes sessions)
- Profile: edit, avatar (presigned upload), language, notification preferences, GDPR export, account deletion (anonymization)
- **View as User:** view sessions, global read-only guard, audit, expiry
- *(parallel)* Mobile: profile and settings screens, admin Users tab, ViewAs banner + mode plumbing
- **Tests:** view-as blocks every non-GET (table-driven over *all* registered routes), data scoping, deactivation, anonymization keeps ledger references
- **Gate:** an admin can browse users and enter/exit View-as with no possible writes.
- **Result:** gate met, verified by integration tests (every write route rejected in view mode), app tests, and end to end against the local stack, including a real presigned profile-picture upload to S3-compatible storage. Not yet run on a physical iPhone or simulator. Decisions: [ADR 0003](adr/0003-users-profiles-view-as.md).
- **Carried forward:** attendance, training and payment history on the user detail (Phases 5 and 6); S3 lifecycle rule for unconfirmed uploads (Phase 10).

### Phase 5 — Wallet and financial system · L (highest risk, most tests) · ✅ done 2026-11-24
- `packages/money` + wallet domain pure functions (deltas, FIFO allocation, reversal math), property-based tests
- Ledger service: locking, sequencing, idempotency, invariants, outbox and audit integration
- Cash payments, adjustments (credit/debit/waiver), refunds, reversals
- Stripe: customer, PaymentIntent creation with limits, webhook endpoint (signature, event store, dedupe), Payment state machine, `REQUIRES_REVIEW` on mismatch, refunds and disputes per D17/D18, stuck-payment sweeper
- Debt creation and automatic FIFO settlement
- Reports: dashboard KPIs, summary, revenue series, debt aging, cash per admin, CSV
- Nightly reconciliation job + alerting
- **Tests:** concurrency (N parallel credits/charges on one wallet → exact final balance), duplicate webhooks, replayed idempotency keys, out-of-order Stripe events, the spec's €10/€6 example, reversal of partially settled debt, top-up reversal creating debt, DB CHECK and trigger enforcement
- **Gate:** reconciliation passes after a randomized simulation of 10k mixed operations.
- **Result:** gate met. Three 10,000-operation runs passed (seeds 20261124, 7, 99; 20/10/5 wallets; 16–32 concurrent workers; about 11,500 ledger rows each), and every reconciliation found 0 issues. One run found a bug: a charge that was never paid and whose debt had been fully waived could not be reversed. It is fixed, and a regression test covers it.
  - **Tests:** CI runs two 1,500-operation seeds, plus ledger, payments, wallet HTTP and report integration tests (373 API tests in total).
  - **End-to-end run against the local stack with stripe-mock:**
    - registration with email verification;
    - PaymentIntent creation;
    - an invalid webhook signature is rejected;
    - a concurrent duplicate webhook credits the wallet once;
    - cash, reversal and a refund to card;
    - dashboard and CSV;
    - reconciliation of the dev database;
    - top-ups are blocked in View as User.
  - Not yet run against a real Stripe test account, Apple Pay or iDEAL, which needs your Stripe keys. Decisions: [ADR 0004](adr/0004-wallet-ledger-and-payments.md).
- **Carried forward:**
  - charging at attendance finalization and charge reversal from attendance corrections, which call the existing ledger methods (Phase 6);
  - wallet, top-up (PaymentSheet) and transaction screens, plus admin money screens in the app (Phase 7);
  - an admin action to resolve a `REQUIRES_REVIEW` payment; until then it is flagged on the dashboard and resolved with a refund or adjustment (Phase 6/7);
  - real alerting on `RECONCILIATION MISMATCH` and payment errors; they are only logged at error level for now (Phase 10);
  - Stripe Customer objects and saved cards, which one-off PaymentSheet top-ups do not need (later, if wanted).

### Phase 6 — Training management · M · ✅ done 2026-11-24
- Training CRUD, cancel (with auto-reversal if finalized), optional recurring series (D7)
- Standing prices + per-training overrides; "final price per user" endpoint
- Reservations with deadline and capacity (row lock); admin overrides
- Attendance marking (bulk, walk-ins), finalization → atomic charges with price snapshot, post-finalization corrections
- Admin attendance queue + "finalize" reminder job
- **Tests:** capacity race, deadline edge cases (DST), price snapshot immutability, PRESENT-only charging, duplicate finalize, correction flows, cancellation refunds
- **Gate:** end-to-end scenario: create → reserve → attend → finalize → charge/debt → top-up → settle.
- **Result:** gate met. The scenario passes as an integration test through the API (with a signed Stripe webhook for the top-up) and against the real local stack (18/18 checks, 0 reconciliation issues on the dev database).
  - **Tests:** 40 new tests (12 unit, 28 integration):
    - a capacity race (15 members for 5 spots);
    - the reservation deadline, to the millisecond;
    - series generation across the March 2026 DST change;
    - price snapshots that never change;
    - only PRESENT members are charged;
    - repeated and concurrent finalization;
    - corrections;
    - refunds when a finalized training is cancelled;
    - the debt warning and debt limit;
    - the D13 reminder.
  - CI: 586 tests across the workspace.
  - Building the gate test found one bug: attendance history missed trainings finalized before they ended. It is fixed. Decisions: [ADR 0005](adr/0005-trainings-reservations-attendance.md).
- **Carried forward:**
  - all training screens in the app (Phase 7);
  - ~~push delivery, translated notification texts, 24 h / 2 h reminders, realtime events~~: done in Phase 8;
  - the per-training report `GET /admin/reports/trainings` from the API design;
  - `/me/dashboard` (Phase 7).

### Phase 7 — Mobile application · L · 🟡 built and tested; TestFlight gate pending
- User: Home dashboard (wallet card prominent, next training, debt banner, recent transactions, unread), Trainings list/detail + reservation, Wallet + top-up (PaymentSheet: card, Apple Pay, iDEAL; return-URL deep link), transaction detail, notifications
- Admin: Dashboard, Users + detail actions (cash payment with confirmation dialog, adjustment, reversal), Trainings (create/edit, reservations, price overrides, attendance + finalize), Finance (wallets, transactions, reports), More (attendance queue, settings, audit)
- Realtime invalidation, offline/error/empty/loading states, skeletons, haptics, light/dark, Dynamic Type, VoiceOver
- **Tests (RNTL + MSW):** auth flows, user and admin dashboards, wallet and top-up states, training and reservation flows, View-as (banner, hidden mutations, exit), language switching
- **Gate:** TestFlight internal build covering every flow.
- **Result:** every member and admin flow listed above is built.
  - **Tests:** 46 app tests pass (RNTL against a mocked API, three runs in a row).
  - **API:** a new notifications inbox (`/me/notifications`, unread count, mark read) with integration tests.
  - **CI:** green with 610 tests.
  - **iOS bundle:** the production bundle builds (`expo export --platform ios`).
  - **Bugs found and fixed while testing:** an endless refetch loop in the refresh-on-focus hook, and a skeleton animation that could start after unmounting.
  - **Gate not met yet:** the TestFlight build needs your Apple Developer account, an App Store Connect app record, an Apple Pay merchant id and Stripe keys (D27), plus a macOS or EAS cloud build. Real-device checks of Apple Pay, iDEAL return links, VoiceOver and Dynamic Type sizes happen on that build.
  - Decisions: [ADR 0006](adr/0006-mobile-app.md).
- **Carried forward:**
  - ~~realtime socket invalidation~~ and ~~push notifications~~: done in Phase 8;
  - native date/time pickers in the training form (it uses typed local date and time fields);
  - an audit-log screen under More;
  - a training-series screen (series are managed through the API);
  - walk-ins are added from Responses with "add anyway";
  - EAS build profiles and the TestFlight submission (Phase 10, or earlier once the accounts exist).

### Phase 8 — Notifications and localization · M · 🟡 built and tested; device gate pending
- APNs provider, device registration lifecycle, outbox → notification → push pipeline, dedupe keys, preferences, quiet hours
- Jobs: 24 h / 2 h reminders, debt reminders, low balance, admin finalize reminders
- Complete Dutch translations (all namespaces, server-side push templates), localized dates and currency, missing-key CI check
- **Tests:** dedupe, preference/quiet-hour filtering, language selection for pushes, token pruning on 410
- **Gate:** every notification event verified on a device in both languages.
- **Result:** built.
  - **Push:** a direct APNs client (HTTP/2, .p8 token auth), device registration and pruning, one transactional notification writer feeding the outbox, per-category preferences, and quiet hours deferred to the end of the window in each member's timezone (payment confirmations exempt).
  - **Reminders and alerts:** 24 h / 2 h training reminders, weekly debt reminders, and low-balance alerts.
  - **Realtime:** Socket.IO with Postgres LISTEN/NOTIFY fan-out, so events go out only on commit.
  - **Shared templates:** one set of EN/NL notification templates used by both the app and the server.
  - **App:** permission card, notification settings, tap-to-open, badge, live updates, and a quiet-hours setting for admins.
  - **Tests:** 573 API tests (59 new) and 62 app tests (16 new). Covered: dedupe, preference and quiet-hour filtering, push language per member, token pruning on 410, retries without double sends, and realtime with real sockets (including no event for a rolled-back change).
  - **Bug found and fixed while testing:** the notification writer opened a second, nested transaction that deadlocked on its own locks.
  - **Gate not met yet:** real APNs delivery, the iOS permission dialog, banners and badges need your Apple Developer account, an APNs key and a device build.
  - Decisions: [ADR 0007](adr/0007-notifications-realtime-localization.md).
- **Carried forward:**
  - Android/FCM (behind the existing `PushProvider` interface);
  - live updates for the viewed member in View as User (the screens refresh on focus);
  - an in-app "notification history" for admins.

### Phase 9 — Testing and optimization · M · ✅ done 2026-11-25
- Coverage targets: wallet/ledger/payments/attendance domain ≥ 95%, services ≥ 85%, overall ≥ 80%
- Security review: OWASP ASVS L2 checklist, dependency audit, secrets scan, rate-limit tuning, auth fuzzing
- Performance: query plans for list and report endpoints, N+1 checks, app startup and list rendering profiling
- Maestro E2E smoke flows on the iOS simulator
- **Gate:** no open high/critical findings; financial edge-case suite green.
- **Result:** gate met.
  - **Coverage:** floors enforced in CI. Money domain 98.8%, other services 98.2%, API overall 96.4%, `@tw/money` 100%, mobile app 83.1% (was 73.2%; new tests for the wallet, admin money screens, finance and email links).
  - **Security:** ASVS L2 review, dependency audit and secrets scan done; [06 Security review](06-security-review.md).
    - **Fixed:** one high dependency advisory, missing `Cache-Control: no-store`, login throttling (per-account and per-IP failure limits), a 500 found by auth fuzzing, Socket.IO frame size.
    - **Open:** no high or critical findings.
  - **Financial edge-case suite** (18 tests) is green. It found and fixed two refund bugs: a failed refund reported twice corrupted the payment's refund bookkeeping, and an out-of-order "pending" event could debit a refund that had already failed.
  - **Performance:** N+1 and `EXPLAIN ANALYZE` checks on a 2,000-member / 50,000-transaction club run in CI. New indexes (ledger date, payments date, 10 foreign keys) bring the admin ledger list from 45 to 7 ms and the dashboard from 55 to 4 ms; [07 Performance review](07-performance.md).
  - **App:** React Compiler enabled, and list virtualization tuned and tested.
  - **Maestro:** six smoke flows written in `apps/mobile/.maestro`.
  - **CI:** 748 tests (689 before Phase 9).
  - Decisions: [ADR 0008](adr/0008-testing-and-optimization.md).
- **Carried forward to Phase 10:**
  - the first Maestro run on a simulator, and startup / scrolling profiling with Xcode Instruments on the TestFlight build;
  - gitleaks and Dependabot or Renovate in CI;
  - a breached-password check (HIBP k-anonymity, ASVS 2.1.7);
  - TLS and certificate policy at the load balancer.

### Phase 10 — Deployment preparation · M · 🟡 built and tested; launch checklist awaits your accounts
- Production infrastructure (EU region): managed Postgres with PITR, Redis, container service for api + worker, secret manager
- Release pipeline: migrate step → rolling deploy; staging smoke tests; Stripe live webhooks; APNs production
- Sentry releases, log shipping, alert rules (reconciliation, webhook failures, outbox backlog, 5xx)
- Backup restore drill; runbooks (incident, refund/dispute handling, reconciliation mismatch)
- iOS: app icons, splash, privacy manifest and App Store privacy labels, account deletion, review notes (physical services → Stripe), EAS Submit → App Store
- **Gate:** production launch checklist signed off.
- **Result:** everything that can be built without your accounts is built and tested.
  - **Hosting:** Render in Frankfurt, chosen 2026-11-26. `render.yaml` describes staging and production (API, worker, PostgreSQL 17 with point-in-time recovery, Redis). One Docker image runs the API, the worker, migrations, the first-admin seed and the restore check. A full deploy was rehearsed locally with Docker.
  - **Release pipeline:**
    - CI adds a secrets scan, a production dependency audit, and an image-plus-migrations check;
    - staging deploys itself and is smoke-tested;
    - production deploys from a version tag after your approval (API first, then worker), then the smoke test and a Sentry release run.
  - **Monitoring:** Sentry alerts (EU, no personal data) for reconciliation mismatches, payments held for review, failed Stripe events, failed or stuck background jobs, and server errors. Crash reporting in the app.
  - **Security carry-overs closed:** breached-password check (Have I Been Pwned), gitleaks, Dependabot, and the clean-up of orphaned profile pictures.
  - **Restore drill:** a read-only `verify-restore` check, including the full money reconciliation. Runbooks for every alert, refunds and disputes, incidents, rollback, restore and secret rotation.
  - **iOS:**
    - dev, staging and production app variants;
    - EAS build profiles;
    - privacy manifest;
    - interim icon and launch screen;
    - store texts (NL/EN), privacy answers and review notes.
  - **Gap found and fixed:** the admin app had no refund screen (D17). It is added and tested.
  - **CI:** 768 tests (748 before Phase 10).
  - Decisions: [ADR 0009](adr/0009-deployment.md). Setup: [09 Deployment guide](09-deployment.md). Gate: [12 Launch checklist](12-launch-checklist.md).
- **Open:**
  - creating the accounts and entering the secrets;
  - the staging checks on a real iPhone (including the Phase 7 and 8 device gates and the first Maestro run);
  - the first restore drill;
  - the accountant's confirmation (D20);
  - App Store submission and the checklist sign-off.
- **Not in the app yet:** an admin list of payments held for review, and a "run reconciliation" button (the dashboard shows both counts; the runbooks explain the workaround).

---

## What I need from you before Phase 2/3
1. **Approval** of the architecture (`02`), database design (`03` + schema) and API structure (`04`).
2. **Answers to the ⛔ DB decisions:** D1, D3, D5, D7, D9, D16, D18 (or "accept defaults").
3. The remaining decisions can be confirmed later. Each will be raised again in the phase where it matters.
4. By Phase 5: a Stripe account (NL). By Phase 8/10: an Apple Developer account + APNs key. You create these accounts yourself; I'll document exactly which keys go where.
