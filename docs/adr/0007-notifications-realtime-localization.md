# ADR 0007: Notifications, realtime and localization (Phase 8)

- **Status:** Accepted
- **Date:** 2026-11-25

## One way to notify
- **`notifyUsers(tx, …)`** (`modules/notifications/notify.ts`) is the only way to create a notification. Ledger, payments, trainings, reminders and finalize reminders all use it. In the caller's transaction it:
  1. inserts the in-app rows with `createManyAndReturn … skipDuplicates`, so a repeated `(user, dedupeKey)` creates nothing;
  2. queues a `notification.push` outbox event for the rows actually created (in batches of 100);
  3. emits `notification.created` to each recipient's socket.
- Nothing is pushed or announced for a change that rolls back.
- Jobs without a business transaction use `notifyUsersNow(prisma, …)`, which opens a short one.
- **Bug found while testing:** the first version guessed whether it had been given a transaction (`'$transaction' in db`). Prisma's transaction client passes that check, so inside a transaction it started a second one. That one waited on row locks held by the first. Training tests timed out at about 13 s each. The two functions are now explicit.

## Push delivery
- **APNs directly:** HTTP/2 with token-based `.p8` (ES256) auth, built on `node:http2` with no extra dependency.
  - The provider token is reused for 40 minutes, and re-signed early after `ExpiredProviderToken`.
  - `410 Unregistered`, `BadDeviceToken` and `DeviceTokenNotForTopic` mean the token is dead. 429, 5xx and network errors are transient.
- `PushProvider` interface implementations:
  - `ApnsPushProvider`;
  - `LogPushProvider`, used in development without credentials;
  - `FakePushProvider`, used in tests.
  - FCM can be added later behind the same interface.
- **`PushService.deliver`**, run by the worker for each outbox event, works per device:
  - **Nothing is sent** to inactive or deleted users, for deleted notifications, or to users without devices.
  - **D23 preferences:** a category turned off gives a `SKIPPED` delivery row. The in-app notification stays.
  - **D22 quiet hours** default to 22:00–08:00 in **each member's own timezone** (`UserProfile.timezone`) and can be changed under Admin → Business settings.
    - Pushes are **deferred** to the end of the window, not dropped: a new outbox event with `availableAt` set to that time.
    - **Payment confirmations are exempt:** `TOP_UP_SUCCEEDED`, `TOP_UP_FAILED`, `CASH_PAYMENT_RECORDED`.
    - A deferred push is skipped if the member already read it in the app.
    - A training reminder whose training has started is dropped. APNs also gets an expiry equal to the start time.
  - **Language:** title and body are rendered in the member's `preferredLanguage`, with dates in their timezone and money in their locale.
  - **Badge:** members get their unread count. Admins get none, because they have no inbox screen to clear it.
  - **Payload data:** `notificationId`, `type`, and `trainingId` / `transactionId` / `paymentId` where present, so a tap opens the right screen.
  - **Dead tokens** are revoked at once ("token pruning").
  - **Transient failures** throw, so the outbox retries with backoff. Devices that already have a `SENT` or `SKIPPED` row are never pushed twice.

## Devices
- **`POST /me/devices`** upserts a native APNs token (64+ hex characters, stored in lower case). A token belongs to one phone, so registering it under another account moves it there. The app registers after sign-in, on every launch and when iOS rotates the token.
- **`DELETE /me/devices/:token`** is called by the app before signing out. It is idempotent and only works for the owner.
- **"Sign out everywhere"**, a password reset and a password change revoke every device. A phone that is still signed in registers again on its next launch.
- **Maintenance:**
  - revokes tokens not seen for 90 days;
  - purges revoked tokens after 30 days, with their delivery rows;
  - purges delivery rows after 90 days.
- Both device routes are writes, so View as User blocks them, like every other write (covered by the table-driven test).

## Jobs (worker, every 5 minutes)
- **Training reminders (D22):** for ATTENDING members, 24 h and 2 h before the start.
  - The 24 h reminder only goes out while the start is more than 2 h away, so the two are never sent together.
  - Members who responded inside a window already know and are skipped.
  - Dedupe keys are `reminder:24h:<trainingId>` and `reminder:2h:<trainingId>`.
- **Debt reminders (D22):**
  - weekly, for open debt that is at least 3 days old;
  - sent between 10:00 and 20:00 local time, with quiet hours still applying on top;
  - stop once the debt is paid.
- **Low balance (D21):** not a job, but checked in the ledger. A `LOW_BALANCE` notification is created when an operation takes the balance from at or above the threshold (default €10) to below it, at most once per 7 days.
- **Finalize reminders (D13):** unchanged from Phase 6, and now pushed.

**Categories:**

| Category | Notification types |
|---|---|
| Trainings | created, changed, cancelled, response set by an admin |
| Payments | top-ups, cash, training charges |
| Reminders | training reminders, debt reminders, low balance, finalize reminders |

## Realtime
- **Socket.IO** is mounted on the API's HTTP server at `/realtime`, WebSocket only, so a load balancer needs no sticky sessions.
  - **Handshake auth:** `auth: { token }`, verified like REST, including the database checks (deactivated, signed out everywhere).
  - **Rooms:** `user:<id>`, `members`, and `admins` for admins.
  - The socket is closed when its access token expires. The app refreshes the token and reconnects.
- **Fan-out with Postgres `LISTEN/NOTIFY` instead of the Redis adapter** in the architecture plan:
  - Events are published with `pg_notify` inside the business transaction. Postgres delivers them only on commit and drops duplicates within it.
  - Every API instance listens and emits to its own sockets. That needs no extra infrastructure and works the same locally, in tests and in production.
  - The payload limit (8 KB) is irrelevant, because events carry ids only.
  - Redis stays the rate-limit store.
- **Events:**

| Event | Sent to | Sent when |
|---|---|---|
| `wallet.updated` | the member | every ledger operation |
| `admin.activity` | admins | every ledger operation |
| `payment.updated` | the member | every PaymentIntent status change |
| `notification.created` | the recipient | a notification is created |
| `training.updated` | members and admins | create, edit, cancel, delete, responses, attendance; for a series, `trainingId: null` |
| `reservation.updated` | admins | a response changes |

- **App:** one socket while signed in and in the foreground.
  - Each event only **invalidates** query keys; data always comes from REST.
  - After a reconnect, everything is refetched, because missed events are not replayed.
  - A dead socket only makes updates less immediate. Screens still refresh on focus and when the app returns to the foreground.

## App
- **expo-notifications:** the config plugin sets the `aps-environment` entitlement (`APNS_MODE=production` for TestFlight and App Store builds). The app uses the **native** APNs token (`getDevicePushTokenAsync`), not an Expo push token.
- **Permission is asked in context, never at launch:**
  - a dismissible card on member Home ("Get reminders and payment updates");
  - Profile → Notifications, which shows the iPhone's status with "Turn on" or "Open Settings".
- **Behaviour:**
  - Pushes show as banners in the foreground and refresh the inbox.
  - Tapping one opens the training, the transaction, the wallet or the inbox; for admins, the attendance screen.
  - The app icon badge follows the unread count. View-as never changes it.
- **Sign-out** unregisters the token and clears the badge first: `SessionController.onBeforeLogout`, capped at 3 s.
- **Business settings:** quiet hours on or off, with start and end times.

## Localization
- **One renderer for both sides:** the new shared `notifications` namespace (EN/NL) and `renderNotification()` in `@tw/i18n` are used by the app (in-app list, in the current app language) and the server (push, in the member's language). Template variants: series, refunded cancellation, charge with debt, 2 h reminder.
- **Missing keys are caught three ways:**
  - `pnpm i18n:check`: every language has every key, with no extras and no empty strings;
  - typed `t()` keys in the app (`types.d.ts`), so typecheck fails on a key that does not exist;
  - i18n unit tests: every `NotificationType`, every variant and every API error code has a translation in both languages.
- **Dates and money** use `Intl` with `en-GB` / `nl-NL`. Server-side texts use the member's timezone.

## Verification
- **API:** 573 tests (59 new).
  - APNs against a local HTTP/2 server: headers, payload, verified ES256 token, refresh, error classification.
  - Quiet-hours arithmetic, including DST and other timezones.
  - Push texts in Dutch and English.
  - Push pipeline: dedupe, preferences, deferral and exemption, read-while-deferred, language per recipient, 410 pruning, retry without double sends, inactive users, stale reminders.
  - Devices: register, move, unregister, validation, sign out everywhere, maintenance.
  - Reminders: windows, dedupe, cancelled trainings, debt cadence and daytime, low-balance cooldown.
  - Realtime with real sockets: auth rejection, per-user isolation, admin activity, training broadcast, no event for a rolled-back transaction, disconnect at token expiry, deactivated accounts.
- **App:** 62 tests (16 new): registration, the permission card, "Not now", unregister before sign-out, badge, tap-to-open, push routing, event mapping, socket refetch, token refresh on rejection.
- **Not verified here:** real APNs delivery, the iOS permission dialog, banners and badges on a device. Those need the Apple Developer account, an APNs key and a device build. This is the Phase 8 gate.
