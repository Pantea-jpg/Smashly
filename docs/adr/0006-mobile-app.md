# ADR 0006: Mobile application (Phase 7)

- **Status:** Accepted
- **Date:** 2026-11-25

## Member app
- **Home puts the wallet first:** balance, any outstanding debt with a banner explaining it is paid off at the next top-up, and a Top up button. Below that: the next training with the member's status, unread notifications, and the three latest transactions.
- **Trainings:** upcoming and past, with infinite scroll. The detail shows the member's own resolved price and where it comes from, places left, the deadline, and "I'll be there" / "I can't make it".
  - The buttons disappear once responses are closed (deadline passed, cancelled or finalized).
  - "I'll be there" is disabled when the training is full.
  - Reserving with debt shows the D10 warning.
  - After finalization the member sees their attendance and charge, including the part that became debt.
- **Wallet:** balance, debt, open debts and the full transaction history. Each transaction's detail shows before/after values, method, reason and a "corrected later" notice.
- **Top-up uses Stripe PaymentSheet** (`@stripe/stripe-react-native`, at the version Expo SDK 58 pins), which offers card, Apple Pay and iDEAL.
  - **The app never credits the wallet.** After the sheet closes, it polls `GET /me/payments/:id` until the server, acting on Stripe's signed webhook, reports `SUCCEEDED`. Only then does it say "added to your wallet".
  - A bank that declines later (iDEAL) shows as failed. Cancelling the sheet is reported as cancelled.
  - One idempotency key is kept per top-up intent, so a retry never creates a second payment.
  - iDEAL and 3-D Secure return through the deep link `trainingwallet://stripe-redirect`, which is handed to `handleURLCallback`.
  - The Apple Pay merchant id comes from `APPLE_MERCHANT_ID` at build time.
- **Notifications:** a new `GET /me/notifications` endpoint (cursor), plus `/unread-count` and `POST /read`.
  - Each type is rendered in the app from `member:notifications.types.*` with its language-neutral params, so the same row reads correctly in English and Dutch.
  - The tab shows an unread badge.
  - "Mark all as read" is a write, so it is hidden, and refused by the server, in View as User.

## Admin app
- **Dashboard:** KPIs for this month (balances, debt, revenue, top-ups, cash, members, upcoming trainings), "needs attention" rows that link to the finalization queue or Finance, and recent transactions that link to the member.
- **Trainings:**
  - list with upcoming and past;
  - create and edit form (local date and time fields; after finalization only title, description and location can change);
  - detail with response counts;
  - responses (set attending or not attending; when the training is full, a confirmation offers "add anyway", which sends `force`);
  - price overrides per member;
  - attendance;
  - cancel with a reason (a warning explains that a finalized training's charges will be reversed).
- **Attendance:**
  - Each member is marked Present / Absent / Excused with a segmented control. Unsaved marks are saved before finalizing.
  - Finalizing asks for confirmation with the number of members to be charged.
  - If the server answers `ATTENDANCE_HAS_PENDING`, a second dialog offers "Mark absent and finalize". That retry reuses the same idempotency key, because it is the same intent.
  - The result shows how many were charged, the total, and how much became debt.
  - After finalization, each row offers Correct, which needs a reason (D11).
  - Before the start, a banner explains that attendance opens when the training begins.
- **Member detail:**
  - **Record cash payment:** amount, then a native confirmation ("Record €25.00 in cash from Anna?"), then one idempotent request.
  - **Adjustment:** credit, debit or debt waiver, with a required reason.
  - The latest transactions, a full list where entries that can be reversed open a reversal screen with a reason, and the member's trainings.
- **Finance:** this month's summary (charged, collected, outstanding, top-ups, refunds), all wallets (searchable, highest debt first) and all transactions.
- **More:** the finalization queue, business settings (top-up limits, maximum balance, low-balance threshold, the D10 debt limit, approval of new accounts) and app settings.

## Cross-cutting
- **Data:** TanStack Query.
  - Every "/me" key includes the subject id, so View-as data never mixes with the admin's own.
  - Lists refresh when a screen regains focus (a stable, effect-based hook) and when the app returns to the foreground.
  - Realtime socket events were added in Phase 8 ([ADR 0007](0007-notifications-realtime-localization.md)).
- **Amounts** typed by people ("12,50", "€ 1.234,50") are parsed into integer cents without floating-point arithmetic.
- **States:**
  - a skeleton while the first data loads (it respects Reduce Motion);
  - an error state with "Try again";
  - an empty state;
  - pull-to-refresh and infinite scroll on long lists;
  - success haptics after payments, reservations and admin money actions.
- **Accessibility:** headers are marked as headers, notification rows read as one sentence ("unread" is announced), rows and buttons have labels, and the system font with Dynamic Type is used throughout.
- **Bugs found while testing:**
  - The first version of the refresh-on-focus hook re-ran on every render, an endless refetch loop on Home. It is now a stable effect.
  - The skeleton could start its animation after unmounting.

  Both are fixed. Separately, React Query's 5-minute cache timers kept Jest alive, so tests now turn garbage collection off. In the app it stays at 5 minutes.

## Verification
- **Tests:** 46 app tests (RNTL, against a mocked API), covering:
  - sign-in and the member home (wallet, debt banner, next training, unread);
  - the error state with retry;
  - Dutch;
  - reservations, including the debt warning, a full training and closed responses;
  - top-up success after the webhook, custom amount validation and a cancelled sheet;
  - notifications and mark all read;
  - View as User hiding mutations;
  - admin: dashboard to queue, cash payment with confirmation and idempotency key, finalization with the pending flow, attendance before the start, the training form;
  - all earlier auth, profile and user tests.

  The suite ran three times in a row without failures.
- **iOS bundle:** `expo export --platform ios` builds the production Hermes bundle (3.8 MB).
- **Not verified here:** a real device, a simulator, Apple Pay, or a real Stripe PaymentSheet. Those need a macOS/EAS build and the Apple Developer and Stripe accounts (D27). They are part of the TestFlight gate.
