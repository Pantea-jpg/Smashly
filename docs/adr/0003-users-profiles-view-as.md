# ADR 0003: User management, profiles and View as User (Phase 4)

- **Status:** Accepted
- **Date:** 2026-11-24

## View as User
- **Header, not a token.** `POST /admin/view-sessions` returns an id that the app sends as `X-View-Session` on GET requests. The admin keeps their own access token: no credential for the user is ever created, so this is not impersonation.
- **Read-only is enforced on the server, three times:**
  1. A global guard, mounted before every router, rejects any non-GET request carrying the header with `403 VIEW_AS_READ_ONLY`. This includes public routes.
  2. `authenticate` refuses unsafe methods in view mode.
  3. The app throws the same error before sending.

  The integration test runs every documented write operation with the header and expects 403.
- **Scope:** only `/me/*` changes subject. Admin endpoints reject view mode. The data export (`GET /me/export`) is blocked in view mode, because downloading a user's full data export is not "seeing their app".
- **Lifetime:**
  - Sessions last 30 minutes, belong to one admin, and target only USER accounts.
  - Starting a new session ends the admin's previous one.
  - A session also ends when the viewed user deletes their account.
  - Ending a session is a `DELETE` sent *without* the header.
- **Audit:** session start and end, plus **every read** (method and path), are written to the audit log with the `viewSessionId`.
- **App:** the member app renders inside a persistent warning-coloured banner showing the user's name and an Exit button. Every control that changes data is hidden via `useCanMutate()`. Cached data for the viewed user is keyed by their id and dropped on exit.

## Admin user management
- **Search:** each word of `q` must match the email, first name or last name (case-insensitive). The existing `pg_trgm` GIN indexes serve this.
- **Listing:** filters by status, role (USER by default) and debt. Sorting is limited to an allow-list. Pages are offset-based with a total, using the API's `offsetList` envelope.
- **Status changes require a reason**, which goes into the audit log.
  - **Deactivation** bumps the token version and revokes refresh tokens, so the user is signed out everywhere immediately.
  - **Activating a `PENDING_APPROVAL` account** approves it and sends an email.
  - **Admins cannot change their own status.**
- **History on the user detail:** attendance, trainings and payments are added with Phases 5 and 6, when those modules exist. The detail endpoint already returns the wallet balance and debt.

## Profiles
- **Profile edit:** first and last name, phone (`null` clears it), and preferred language. Changing the language in the app's settings also saves it to the profile (the item carried over from Phase 3), so emails and future push notifications use it.
- **Password change:** requires the current password, revokes all sessions and outstanding access tokens, and returns a fresh session that the app adopts. A "password changed" email is sent.
- **Notification preferences:** one row per category (`TRAININGS`, `PAYMENTS`, `REMINDERS`). A category with no stored row means push is enabled. The in-app notification history is always kept.
- **Profile pictures:**
  1. `POST /me/avatar/upload-url` returns a presigned PUT, valid for 5 minutes, for a new key under `avatars/<userId>/`. **Content-Type and Content-Length are part of the signature**: verified end to end, a file of a different size is rejected by storage with 403.
  2. `PUT /me/avatar` checks the key prefix, then a HEAD request verifies the object's type (JPEG/PNG) and size (≤ 5 MB). An invalid object is deleted. On success the previous picture is deleted.
  3. Downloads use presigned GET URLs valid for 1 hour, so the bucket stays private.
  4. The app crops to a square, resizes to 512 px and saves as JPEG at 80% quality before uploading.
- **S3 checksums:** AWS SDK v3's default `requestChecksumCalculation: WHEN_SUPPORTED` embeds a CRC32 of the *empty* body in presigned PUT URLs, so every real upload fails with `BadDigest`. This affects AWS S3 too, not just SeaweedFS. Set to `WHEN_REQUIRED`. The end-to-end run against real storage found this; the in-memory fake could not. A unit test now guards against it.

## Account deletion (GDPR art. 17, Apple 5.1.1(v))
- Requires the password. Refused while the wallet has a balance or debt (D4), and refused for admins.
- **Anonymises instead of deleting:**
  - email becomes `deleted+<id>@deleted.invalid`, so the address can register again;
  - the name becomes "Deleted user", and the phone and picture are removed;
  - the password hash is replaced with an unusable random one;
  - all sessions, devices, preferences and pending one-time tokens are removed.
- **Financial rows stay**, still pointing at the same user id (Dutch 7-year retention).

## Local object storage
- **SeaweedFS (Apache-2.0)** runs in Docker Compose. Docker Hub no longer serves the `minio/minio` image, and `quay.io/minio/minio` could not be pulled either.
- The API speaks plain S3, so production can use AWS S3, Cloudflare R2, Scaleway or another S3-compatible service without code changes.
- `pnpm --filter @tw/api storage:setup` creates the local bucket.

## Follow-ups
- **Production bucket (Phase 10):** a lifecycle rule to expire unconfirmed uploads under `avatars/` after 1 day (orphans are harmless but cost storage), and keeping the bucket private.
- **Physical-device testing:** the device must reach `S3_ENDPOINT`. Use the computer's LAN IP instead of `localhost`.
