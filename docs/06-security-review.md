# 06 — Security review (Phase 9)

- **Date:** 2026-11-25
- **Scope:** API (`apps/api`), mobile app (`apps/mobile`), shared packages, dependencies, CI.
- **Standard:** OWASP ASVS 4.0.3, Level 2, applied to a JSON API with a native client. Requirements for browsers, cookies, server-rendered HTML and file upload to the API do not apply. Avatars go directly to S3 through presigned URLs.
- **Result:** **no open high or critical findings.** One high-severity dependency advisory and two financial bugs were found and fixed. Every fix has a test that fails without it.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| S1 | High | Dependency `effect` ≤ 3.22.0 (GHSA-7589-6fvf-x4pw, ReDoS), pulled in by `@prisma/config`. | **Fixed:** `pnpm-workspace.yaml` override to 3.22.5, Prisma CLI verified. |
| S2 | High (financial integrity) | Stripe sends both `refund.failed` and `refund.updated` for one failed refund. The wallet was credited once, but the payment's refunded amount was reduced twice, so its status could turn back to "SUCCEEDED" while money had been refunded. | **Fixed:** the payment is adjusted only when the ledger credit is new. Covered by `payments-edge.int.test.ts`, which also delivers both reports at the same moment. |
| S3 | High (financial integrity) | When `refund.failed` arrived before a delayed `refund.created (pending)` (Stripe does not guarantee order), the late event debited the wallet for a refund that never happened. | **Fixed:** stored Stripe events are checked for a final failure before debiting, and refund and dispute events lock the payment row (payment → wallet lock order). |
| S4 | Medium | API responses (wallet, transactions, personal data) had no `Cache-Control`, so a proxy or device HTTP cache could keep them (ASVS 8.2.1). | **Fixed:** `Cache-Control: no-store` on every `/api/v1` response, including errors. Tested. |
| S5 | Medium | Login throttling was only per IP + email (5 a minute). A distributed attack on one account, or one IP spraying many accounts, was only slowed by the global limit (ASVS 2.2.1). | **Fixed:** two extra failure-only limits. See *Rate limits*. Tested. |
| S6 | Low | A correctly signed access token with a non-UUID subject caused a 500 (database input error) instead of a 401. Requires the signing key, so not exploitable, but found by fuzzing. | **Fixed:** the token service validates `sub` as a UUID. Covers REST and the realtime handshake. |
| S7 | Low | The Socket.IO server accepted frames up to 1 MB although clients never send events. | **Fixed:** `maxHttpBufferSize` 16 KB. |
| S8 | Low (accepted) | Registration answers `EMAIL_ALREADY_REGISTERED`, which reveals that an address has an account. | **Accepted:** a club app where members know each other; the register limit (10 an hour per IP) bounds harvesting. Login and password reset do not reveal accounts. |
| S9 | Moderate (accepted) | `glob` 10/13 and `minimatch` 9/10 advisories (ReDoS on attacker-controlled patterns). | **Accepted:** only in test and build tooling (Jest, Testcontainers, Expo fingerprint), never with untrusted patterns, not in the API image or the app bundle. Revisit when upstream updates. |

## Dependency audit and secrets scan

- `pnpm audit`: 1 high, fixed (S1). 4 moderate remain, all development-only (S9). `pnpm audit --prod` has no high or critical findings.
- **Secrets scan:** a regex scan of the workspace (excluding `node_modules`, build output and the gitignored `.env`) for Stripe keys (`sk_`, `rk_`, `whsec_`), private keys (PEM), AWS keys, GitHub and Slack tokens, and JWTs found nothing.
  - Test keys are generated at runtime.
  - `.env.example` holds only empty values, plus the local MinIO credentials of `infra/docker-compose.yml`.
  - `.gitignore` covers `.env*`, `*.p8`, `*.p12`, `*.pem`, `*.key` and provisioning profiles.
- **Done in Phase 10:** `gitleaks` scans the full history on every CI run, `pnpm audit --prod --audit-level high` runs in CI, and Dependabot opens weekly update pull requests ([ADR 0009](adr/0009-deployment.md)).

## Rate limits (after tuning)

| Limit | Key | Window | Max | Counts |
|---|---|---|---|---|
| global | IP (IPv6 /56) | 1 min | 300 | every request |
| login | IP + email | 1 min | 5 | every attempt |
| loginAccount *(new)* | email (any IP) | 15 min | 10 | failed attempts only |
| loginIp *(new)* | IP | 15 min | 30 | failed attempts only |
| register | IP | 1 h | 10 | every attempt |
| refresh | IP | 1 min | 30 | every attempt |
| passwordForgot | IP + email | 1 h | 5 | every attempt |
| passwordReset | IP | 1 h | 10 | every attempt |
| emailVerify / emailResend | IP / user | 1 h | 20 / 3 | every attempt |

- Counters live in Redis in staging and production, so all API instances share them.
- `loginAccount` is a soft lock that expires by itself. It trades a short lockout an attacker could cause for protection against password guessing on one account. Successful sign-ins never count.

## Auth fuzzing (`auth-fuzz.int.test.ts`, fast-check)

- **Random input:** 200 random `Authorization` headers and 150 one-character mutations of a valid token are all rejected with 401.
- **Forged tokens are rejected:**
  - `alg: none`;
  - HS256 signed with the public key (algorithm confusion);
  - a foreign Ed25519 key with the right `kid`;
  - an unknown `kid`;
  - a wrong `typ`, `iss` or `aud`;
  - an expired token;
  - an invalid role or wrongly typed claims;
  - a stale token version ("signed out everywhere");
  - a deleted user.
- **Role claims:** a validly signed token that claims `ADMIN` for a member gets 403 on admin routes, because the database role wins.
- **Public endpoints:** 200 arbitrary JSON bodies across login, register, refresh, forgot, reset and verify never return 2xx (except the intentional 202 of forgot-password) and never 5xx. Random refresh, reset and verification tokens are rejected.
- **Other checks:** 40 random wrong passwords never sign in. `__proto__` and `role` fields on registration are ignored. A 200 KB body gets 413 before it is parsed.

## ASVS 4.0.3 Level 2 checklist

✅ met · ➖ not applicable · 🟡 partly / Phase 10

| Chapter | Status | Evidence |
|---|---|---|
| **V1 Architecture** | ✅ | Threat model and trust boundaries in `01`/`02`. One ledger service moves money. Server-side authorization only. ADRs record security decisions. |
| **V2 Authentication** | ✅ | Argon2id (`password.ts`). Passwords 10–128 characters, no composition rules (2.1). Generic login errors, constant-time dummy verification for unknown accounts. Login throttling (2.2.1, S5). Single-use, hashed, expiring reset and verification tokens. Password change and reset revoke all sessions and devices. Breached-password check (2.1.7): Have I Been Pwned with k-anonymity on registration, reset and change (Phase 10). |
| **V3 Session management** | ✅ | 15-minute EdDSA access tokens, opaque refresh tokens stored as SHA-256, rotation with reuse detection that revokes the family. Logout and "sign out everywhere" (`tokenVersion`) take effect on the next request because every request re-checks the user. Tokens live in the iOS Keychain (`expo-secure-store`). |
| **V4 Access control** | ✅ | Default deny: `authenticate` + `requireRole` on every route (table-driven RBAC test over all admin routes). Ownership enforced in queries (`userId` from the token, never the body). View as User is read-only through a global guard (all writes blocked, reads audited). |
| **V5 Validation and encoding** | ✅ | Zod schemas on every body, query and param (strict, length-capped). 100 KB JSON limit, `query parser: simple`. Parameterized SQL only (Prisma and tagged `$queryRaw`). No HTML rendering. Email templates escape input. |
| **V6 Cryptography** | ✅ | Node `crypto` and `jose` only. Ed25519 JWT keys with rotation (`kid`). 256-bit random opaque tokens. ES256 APNs key. Stripe webhook HMAC verified over raw bytes. No custom crypto. |
| **V7 Errors and logging** | ✅ | Error envelope without stack traces or internals. Pino redaction of authorization, cookies, passwords, tokens, emails and phones. Audit log (append-only trigger) for every money operation, admin action, login failure and view-session read. Request ids. |
| **V8 Data protection** | ✅ | `Cache-Control: no-store` (S4). Only token hashes are stored. Avatars in a private bucket behind presigned URLs. Account deletion anonymizes while keeping the ledger (legal retention). The data export endpoint is blocked in view mode. |
| **V9 Communications** | 🟡 | HSTS through helmet. TLS terminates at the load balancer, and certificates and TLS policy are configured in Phase 10. APNs and Stripe use TLS. |
| **V10 Malicious code** | ✅ | Locked dependencies (`--frozen-lockfile`), build scripts allow-listed (`onlyBuiltDependencies`), audit in this review. gitleaks and a production dependency audit in CI, and Dependabot (Phase 10). |
| **V11 Business logic** | ✅ | Idempotency keys on every money write. Row locks (wallet, payment, training). Ledger invariants enforced by database CHECKs and nightly reconciliation. Amount, balance and debt limits. Rate limits. Financial edge-case suite (below). |
| **V12 Files and resources** | ✅ | Avatar uploads: presigned PUT with content type and checksum, size limited, confirmed server-side, then resized on the device. No user-supplied file paths. |
| **V13 API** | ✅ | JSON only. CORS allow-list (none by default). Stripe webhook signature required. Strict content types. OpenAPI generated from the same schemas. |
| **V14 Configuration** | ✅ | Environment validated at startup (Zod). Production refuses dev-only settings (API docs, demo seed, missing Stripe or APNs keys). `x-powered-by` off, helmet headers, `trust proxy` explicit. Containers run as non-root. Debug endpoints are off in production. |

## Financial edge-case suite

`payments-edge.int.test.ts` (18 tests) adds these cases to the existing payment, ledger and simulation tests:
- **Failed refunds:** reported twice or at the same moment, or arriving out of order; pending then canceled; failed immediately at creation; Stripe unavailable.
- **Chargebacks:** a won dispute delivered twice; a lost dispute after the money was spent (becomes debt).
- **Unknown objects:** events for unknown intents, refunds and disputes are acknowledged and move nothing.
- **Retries:** an event that failed is stored with its error and processed on Stripe's retry.
- **Payment states:** processing (iDEAL), 3-D Secure and cancellation; a late success after cancellation never credits; five simultaneous success events credit once; a success in another currency is held for review.
- **Sweeper:** keeps going when Stripe fails for one payment.
- **Ledger idempotency:** idempotency keys across operations and wallets.
- **Reconciliation:** every money test ends by checking that cached totals equal the sum of ledger rows.
