# ADR 0002: Authentication and backend foundation (Phase 3)

- **Status:** Accepted
- **Date:** 2026-11-24

## Decisions

### Tokens and sessions
- **Access token:** EdDSA (Ed25519) JWT, 15 minutes, `typ: at+jwt`, with claims `sub`, `role`, `sid` (session = refresh-token family) and `tv` (token version). The `kid` header enables key rotation: `JWT_PREVIOUS_PUBLIC_KEY` keeps the old key valid for verification while the new one signs.
- **Every request re-checks the user** with one primary-key lookup: status, deletion, token version and role. Deactivation, "log out everywhere" and role changes therefore apply immediately, not after the 15 minutes. A single `/auth/logout` leaves the current access token valid until it expires; the app discards it.
- **Refresh token:** 256-bit opaque value. Only its SHA-256 hash is stored. It slides to 30 days and is rotated on every use. **Reuse detection:** presenting a rotated token revokes the whole family and is audited.
- **Grace window (20 s):** if a rotated token comes back within 20 seconds *and its successor was never used* (typically a lost response or the app being killed mid-refresh), the successor is replaced instead of revoking the session. This trades a 20-second window for not logging users out on flaky mobile networks; Auth0 calls the same idea a "reuse interval".
- **Mobile:** the access token stays in memory only. The refresh token lives in the Keychain with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, so it is never synced or restored to another device. Refresh is **single-flight**: concurrent requests share one refresh, because a second parallel refresh would look like theft.

### Passwords and account flows
- **Hashing:** Argon2id with m=19 MiB, t=2, p=1 (OWASP), rehashed on login when the parameters change. Logins for unknown accounts run a dummy verification, so timing does not reveal whether an account exists.
- **Policy:** 10 to 128 characters, no composition rules (NIST 800-63B). A breached-password check is a possible later addition.
- **Registration:** returns `409 EMAIL_ALREADY_REGISTERED` for an existing email. The UX benefit was judged to outweigh the enumeration risk; registration is rate-limited per IP. Forgot-password always returns `202`.
- **Reset and verification links:** single use, enforced by a conditional update. Reset links expire after 30 minutes and verification links after 48 hours; only the newest link works. A password reset revokes all sessions and emails a "password changed" notice.
- **Email verification** is recorded (`emailVerified`) but does not block sign-in. Phase 5 requires it before online top-ups.
- **Approval mode:** the setting `registration.requireApproval` (D2) creates accounts as `PENDING_APPROVAL`. Such accounts get no tokens until an admin approves them; the approval UI arrives in Phase 4.

### Infrastructure
- **Route builder (`ApiRouter`):** each endpoint is declared once, and that one declaration drives the Express route, Zod validation, response filtering and OpenAPI docs. Responses are parsed with their schema, which strips unknown fields, so an accidental extra property such as a password hash can never reach a client. `apps/api/openapi.json` is generated from these declarations, and CI fails if it is stale.
- **Rate limits:** Redis/Valkey store, required in staging and production. Login is limited to 5 per minute per IP + email.
- **Idempotency-Key middleware:** the response is stored *before* it is sent, so an immediate retry sees it. 5xx responses are not stored. The same key with a different body returns 409. Financial writes will still carry their own unique ledger key (Phase 5), to cover the gap between commit and storing the response.
- **Transactional outbox:** events are claimed with `FOR UPDATE SKIP LOCKED` plus a lease, retried with exponential backoff, and marked `failedAt` after 10 attempts. One-time links are redacted from the stored payload after delivery. Emails are rendered server-side in the user's language from `packages/i18n`.
- **Prisma preview features:** `partialIndexes` and `postgresqlExtensions` are enabled. They declare the partial unique index on active charges and the `pg_trgm` GIN search indexes in the schema itself, so `migrate diff` stays empty and future migrations will not try to drop them. CHECK constraints, triggers and grants are hand-written SQL, and CI verifies there is no drift.
- **Append-only triggers raise SQLSTATE `P0001`.** The original `23001` was reported by Prisma as "Foreign key constraint violated" and hid the real reason. This was fixed in a forward migration rather than by editing the applied one.
- **Integration tests** run against real PostgreSQL 17 through Testcontainers, so locks, constraints and migrations are tested for real. The RBAC test enumerates every documented route: secured routes must return 401 without a token, and every admin route must return 403 for a USER.

### Local development
- **Postgres port:** the Docker Postgres is published on **5433**, because a locally installed PostgreSQL commonly occupies 5432.

## Consequences
- **Adding an endpoint** means declaring it through `ApiRouter`, regenerating `openapi.json`, and getting RBAC coverage automatically.
- **New append-only tables** need their own trigger and `REVOKE` in their migration.
