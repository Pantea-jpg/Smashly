# Sports Training Management & Wallet Platform

**Status:** All ten phases are built. Phases 1–6 and 9 are complete. **7 (mobile app), 8 (notifications) and 10 (deployment preparation) are built and tested;** their remaining gates need your accounts (Apple Developer, Stripe, Render, Sentry) and a real iPhone. Hosting: Render in Frankfurt. Start with the [deployment guide](docs/09-deployment.md) and the [launch checklist](docs/12-launch-checklist.md).

## Repository layout

| Path                 | What it is                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/api`           | Express 5 + Prisma 7 REST API (TypeScript, ESM). Bundled with esbuild for production.                           |
| `apps/mobile`        | Expo SDK 58 / React Native app (iOS first), React Navigation, TanStack Query, Zustand, i18next.                 |
| `packages/contracts` | Zod schemas and types shared by API and app: enums, error codes, envelopes, pagination.                         |
| `packages/money`     | Integer minor-unit money helpers (no floats), parsing and locale formatting.                                    |
| `packages/i18n`      | English and Dutch translation resources plus language resolution.                                               |
| `packages/config`    | Shared strict TypeScript configs.                                                                               |
| `infra/`             | Docker Compose for local Postgres 17, Valkey (Redis-compatible), Mailpit and SeaweedFS (S3-compatible storage). |
| `docs/`              | Architecture documents and ADRs.                                                                                |

## Getting started

Prerequisites: Node 24 (`.nvmrc`), Corepack (bundled with Node), Docker Desktop.

```bash
corepack enable                          # provides the pinned pnpm 10.34.9
pnpm install                             # also generates the Prisma client
pnpm db:up                               # Postgres (host port 5433), Valkey, Mailpit, SeaweedFS (S3), stripe-mock
cp apps/api/.env.example apps/api/.env
pnpm --filter @tw/api keys:generate      # paste JWT_KEY_ID / JWT_PRIVATE_KEY into apps/api/.env
# set SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD in apps/api/.env, then:
pnpm --filter @tw/api db:deploy          # apply migrations
pnpm --filter @tw/api db:seed            # first admin (+ demo users if SEED_DEMO_USERS=true)
pnpm --filter @tw/api storage:setup      # private bucket for profile pictures
pnpm dev:api                             # http://localhost:3000/health/ready, docs at /api/docs
pnpm dev:worker                          # delivers emails (and later push) from the outbox
pnpm dev:mobile                          # Expo dev server
```

- **Mailpit** shows every email the worker sends: http://localhost:8025.
- **Stripe:** without keys, online top-ups return `PAYMENTS_UNAVAILABLE` and cash still works. For real test payments, put your Stripe test keys in `apps/api/.env` and forward webhooks with `stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe`. For offline runs, the stripe-mock lines in `.env.example` are enough.
- **Profile pictures** are uploaded straight to S3 via presigned URLs. On a physical iPhone, set S3_ENDPOINT to your computer's LAN IP so the phone can reach it.
- **The app** reads `EXPO_PUBLIC_API_URL` (default `http://localhost:3000`). On a physical iPhone, use your computer's LAN IP.
- **Email links** open the app via `trainingwallet://reset-password?token=…` and `…/verify-email?token=…`.
- **iOS builds:** the app runs as a development build. `pnpm --filter @tw/mobile ios` needs macOS with Xcode, or you can build in the cloud with EAS.

## Quality gates (same as CI)

```bash
pnpm ci   # format check → lint (type-aware) → typecheck → i18n parity → unit + Postgres integration tests
```

Integration tests start a throwaway PostgreSQL 17 with Testcontainers, so Docker must be running. CI additionally checks migration drift and that `apps/api/openapi.json` is up to date.

The Phase 5 money gate (10,000 random concurrent operations, then reconciliation) runs on its own throwaway database:

```bash
pnpm --filter @tw/api simulate:ledger -- --ops 10000 --seed 42
```

## Documents

| #        | Document                                                                                      | Contents                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01       | [Requirements analysis](docs/01-requirements-analysis.md)                                     | Scope, assumptions, risks, business decisions with the accepted defaults                                                                             |
| 02       | [System architecture](docs/02-architecture.md)                                                | Modular monolith, ledger service, outbox, flows, security, mobile, i18n, infra, folder structure                                                     |
| 03       | [Database design](docs/03-database.md)                                                        | ERD, financial model with worked examples, constraints, indexes, retention. Schema: [`apps/api/prisma/schema.prisma`](apps/api/prisma/schema.prisma) |
| 04       | [API design](docs/04-api.md)                                                                  | Conventions, envelope, errors, idempotency, endpoints, realtime events                                                                               |
| 05       | [Roadmap](docs/05-roadmap.md)                                                                 | Phases 1–10 with deliverables, tests and gates                                                                                                       |
| 06       | [Security review](docs/06-security-review.md)                                                 | Phase 9 findings and fixes, ASVS L2 checklist, dependency audit, secrets scan, rate limits, auth fuzzing                                             |
| 07       | [Performance review](docs/07-performance.md)                                                  | N+1 and query-plan checks on a large club, the Phase 9 indexes, measured timings, app list and startup work                                          |
| 09       | [Deployment guide](docs/09-deployment.md)                                                     | Render setup, secrets, Stripe webhooks, GitHub releases, Sentry alerts, TestFlight and App Store builds                                              |
| 10       | [Runbooks](docs/10-runbooks.md)                                                               | What to do for each alert, refunds and disputes, incidents, rollback, backup restore, secret rotation                                                |
| 11       | [App Store submission](docs/11-app-store.md)                                                  | Store texts (NL/EN), privacy answers, review notes, screenshots                                                                                      |
| 12       | [Launch checklist](docs/12-launch-checklist.md)                                               | The Phase 10 gate: what is done, what needs your accounts, sign-off                                                                                  |
| 13       | [Trying the app](docs/13-testing.md)                                                          | Low-cost test setup on Render (no Stripe or other accounts) and the app in Expo Go on an iPhone                                                      |
| ADR 0001 | [Stack and pinned versions](docs/adr/0001-stack-and-versions.md)                              | Why each version was chosen                                                                                                                          |
| ADR 0002 | [Auth and backend foundation](docs/adr/0002-auth-and-backend-foundation.md)                   | Tokens, rotation and reuse detection, passwords, outbox, idempotency, route builder, migrations                                                      |
| ADR 0003 | [Users, profiles, View as User](docs/adr/0003-users-profiles-view-as.md)                      | Read-only view sessions, account deletion, profile pictures, S3 checksum fix                                                                         |
| ADR 0004 | [Wallet ledger and payments](docs/adr/0004-wallet-ledger-and-payments.md)                     | Ledger rules, debt and reversals, Stripe flows, reports, reconciliation, the 10k simulation gate                                                     |
| ADR 0005 | [Trainings, reservations, attendance](docs/adr/0005-trainings-reservations-attendance.md)     | Capacity locking, series and DST, pricing snapshots, finalization, corrections, cancellation refunds                                                 |
| ADR 0006 | [Mobile app](docs/adr/0006-mobile-app.md)                                                     | Member and admin screens, PaymentSheet top-up flow, notifications inbox, states, verification and what needs a device                                |
| ADR 0007 | [Notifications, realtime, localization](docs/adr/0007-notifications-realtime-localization.md) | APNs push pipeline, quiet hours, reminders, devices, Socket.IO over Postgres NOTIFY, shared EN/NL templates                                          |
| ADR 0008 | [Testing and optimization](docs/adr/0008-testing-and-optimization.md)                         | Coverage floors in CI, financial edge cases and the refund bugs, auth fuzzing, performance tests, React Compiler, Maestro                            |
| ADR 0009 | [Deployment preparation](docs/adr/0009-deployment.md)                                         | Render Blueprint, one image for API/worker/migrations, release pipeline, alerts, restore drills, refund screen, app variants                         |
| API      | [`apps/api/openapi.json`](apps/api/openapi.json)                                              | Generated OpenAPI 3.1 document (source of truth for endpoints)                                                                                       |

## Key architectural decisions

1. **Modular monolith** (Express 5 + Prisma + PostgreSQL), with separate `api` and `worker` processes. Financial changes stay inside single ACID transactions.
2. **One Wallet Ledger Service** is the only code that can move money: wallet row locks, gap-free sequences, unique idempotency keys, DB CHECK constraints, append-only trigger.
3. **Each ledger row records balance _and_ debt.** Debt is tracked per charge and settled FIFO automatically on every credit.
4. **Charges are created at attendance finalization** from a price snapshot (override → standing price → default).
5. **Stripe credits only from verified webhooks.** Methods: card, Apple Pay, iDEAL.
6. **View as User** is a server-enforced, audited, read-only context.
7. **Transactional outbox** for push, email and socket events.
