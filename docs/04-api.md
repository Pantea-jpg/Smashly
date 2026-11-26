# 04 — API Design (REST · Express 5 · OpenAPI)

Status: **Draft for approval** · 2026-11-24

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://api.<domain>/api/v1`. Breaking changes → `/api/v2`, with v1 supported for at least two app releases (old app versions stay in the wild). |
| Format | JSON, `camelCase`. Money is always `{ "amountMinor": 1250, "currency": "EUR" }`. Timestamps are ISO-8601 UTC. |
| Auth | `Authorization: Bearer <accessToken>`. View-as adds `X-View-Session: <id>`. |
| Language | `Accept-Language: nl` selects the language for server-rendered text (emails, push). API error *codes* are language-neutral; the app translates them. |
| Idempotency | `Idempotency-Key: <uuid>` is **required** on: top-up creation, cash payments, adjustments, refunds, reversals, attendance finalization, attendance corrections. Optional (and honoured) on other POSTs. |
| Validation | Zod schemas from `packages/contracts`. Unknown fields are stripped. Money must be an integer within configured bounds. |
| Docs | OpenAPI 3.1 generated from the Zod schemas. Swagger UI at `/api/docs` in non-production environments. `openapi.json` committed and diffed in CI. |

### Response envelope
```jsonc
// 200/201
{ "data": { ... }, "meta": { "requestId": "..." } }

// list
{ "data": [ ... ], "meta": { "requestId": "...", "page": { "nextCursor": "...", "hasMore": true } } }
// admin tables (offset): "page": { "page": 2, "pageSize": 25, "total": 312 }

// error (4xx/5xx)
{ "error": { "code": "RESERVATION_DEADLINE_PASSED", "message": "Reservation deadline has passed", "details": {...}, "requestId": "..." } }
```

### Pagination, filtering, sorting
- **Feeds** (transactions, notifications, audit): cursor-based `?limit=20&cursor=<opaque>`. Stable while new rows arrive.
- **Admin tables** (users, trainings, transactions): `?page=1&pageSize=25` (max 100), with a total count.
- **Sorting:** `?sort=-createdAt,lastName`, checked against a per-endpoint allow-list.
- **Filtering:** explicit query params per endpoint (`status=ACTIVE&q=anna&from=2026-01-01&to=2026-01-31&type=CASH_TOP_UP`).

### Error codes (language-neutral)
`VALIDATION_ERROR` 400 · `UNAUTHENTICATED` 401 · `TOKEN_EXPIRED` 401 · `INVALID_CREDENTIALS` 401 · `ACCOUNT_INACTIVE` 403 · `FORBIDDEN` 403 · `VIEW_AS_READ_ONLY` 403 · `NOT_FOUND` 404 · `CONFLICT` 409 · `IDEMPOTENCY_KEY_REUSED` 409 · `IDEMPOTENCY_IN_PROGRESS` 409 · `TRAINING_FULL` 409 · `TRAINING_CANCELLED` 409 · `RESERVATION_DEADLINE_PASSED` 409 · `ATTENDANCE_FINALIZED` 409 · `ATTENDANCE_HAS_PENDING` 409 · `ALREADY_REVERSED` 409 · `INSUFFICIENT_BALANCE` 409 (refunds only) · `AMOUNT_OUT_OF_RANGE` 422 · `BALANCE_LIMIT_EXCEEDED` 422 · `ACCOUNT_HAS_BALANCE_OR_DEBT` 409 · `RATE_LIMITED` 429 · `PAYMENT_PROVIDER_ERROR` 502 · `INTERNAL_ERROR` 500

### Authorization model
- `/auth/*`: public (rate-limited).
- `/me/*`: any authenticated user. The data scope is **always** `ctx.subject.id`; endpoints never accept a user ID. Admins can only reach `/me/*` reads through a View-as session.
- `/admin/*`: `ADMIN` only, enforced at router level.
- `/webhooks/*`: no JWT; Stripe signature only.
- **View-as guard:** with `X-View-Session` present, any method other than `GET`/`HEAD` → `403 VIEW_AS_READ_ONLY`, before routing.

---

## 2. Endpoints

### 2.1 Auth — `modules/auth`
| Method | Path | Body / Notes |
|---|---|---|
| POST | `/auth/register` | `{ email, password, firstName, lastName, phone?, preferredLanguage }` → tokens (or `PENDING_APPROVAL`) |
| POST | `/auth/login` | `{ email, password }` → `{ accessToken, refreshToken, user }` |
| POST | `/auth/refresh` | `{ refreshToken }` → rotated pair. Reuse of an old token revokes the family. |
| POST | `/auth/logout` | Revokes the current token family, unregisters the current device token |
| POST | `/auth/logout-all` | Bumps `tokenVersion` |
| POST | `/auth/password/forgot` | `{ email }`. Always returns 202 (no account enumeration). |
| POST | `/auth/password/reset` | `{ token, newPassword }` → revokes all sessions |
| POST | `/auth/email/verify` | `{ token }` |
| POST | `/auth/email/resend` | rate-limited |

### 2.2 Me: profile and preferences — `modules/profiles`
| Method | Path | Notes |
|---|---|---|
| GET | `/me` | User + profile + role + wallet summary |
| PATCH | `/me/profile` | `{ firstName?, lastName?, phone?, preferredLanguage? }` |
| POST | `/me/avatar/upload-url` | Presigned PUT URL (content-type and size limited) |
| PUT | `/me/avatar` | `{ objectKey }` confirm |
| PATCH | `/me/password` | `{ currentPassword, newPassword }` |
| GET / PUT | `/me/notification-preferences` | `[{ category, pushEnabled }]` |
| GET | `/me/export` | GDPR data export (JSON) |
| DELETE | `/me` | Account deletion → anonymization. `409 ACCOUNT_HAS_BALANCE_OR_DEBT` if applicable (D4). |

### 2.3 Me: dashboard, wallet, transactions, payments — `wallets`, `transactions`, `payments`, `debts`
| Method | Path | Notes |
|---|---|---|
| GET | `/me/dashboard` | One aggregated call: wallet card, next training + my status/price, debt summary, 5 recent transactions, unread count |
| GET | `/me/wallet` | `{ balance, debt, currency, topUpLimits, presets }` |
| GET | `/me/transactions` | Cursor feed; `?type=&from=&to=` |
| GET | `/me/transactions/:id` | Includes linked training, settlements, derived `status` (`POSTED` / `REVERSED`) |
| GET | `/me/debts` | Open and settled debts with their trainings |
| POST | `/me/wallet/top-ups` | `{ amountMinor, currency }` + **Idempotency-Key** → `{ paymentId, clientSecret, ephemeralKey, customerId, publishableKey }` |
| GET | `/me/payments/:id` | Status polling after PaymentSheet |

### 2.4 Me: trainings and reservations — `trainings`, `reservations`, `attendance`
| Method | Path | Notes |
|---|---|---|
| GET | `/me/trainings` | `?scope=upcoming\|past&cursor=`. Each item includes `myPrice` (resolved), `myReservation`, `spotsLeft`, `deadlinePassed`, `myAttendance`, `myCharge`. |
| GET | `/me/trainings/:id` | Detail |
| PUT | `/me/trainings/:id/reservation` | `{ status: "ATTENDING" \| "NOT_ATTENDING" }`. Idempotent upsert. Checks deadline, capacity (row lock), user active. |
| GET | `/me/attendance` | Attendance history |

### 2.5 Me: notifications and devices — `notifications`
| Method | Path | Notes |
|---|---|---|
| GET | `/me/notifications` | Cursor feed; `?unread=true` |
| GET | `/me/notifications/unread-count` | |
| POST | `/me/notifications/:id/read` | |
| POST | `/me/notifications/read-all` | |
| DELETE | `/me/notifications/:id` | Soft delete |
| POST | `/me/devices` | `{ token, platform, provider, appVersion }`. Upsert by token. |
| DELETE | `/me/devices/:token` | |

### 2.6 Admin: dashboard, view-as, settings, audit — `admin`, `reports`
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/dashboard` | KPIs (total/active users, upcoming sessions, Σ balances, Σ online top-ups, Σ cash, training revenue, outstanding debt), "needs attention" (unfinalized trainings, `REQUIRES_REVIEW` payments, reconciliation alerts), recent activity and transactions, upcoming sessions. `?from&to` for period KPIs. |
| POST | `/admin/view-sessions` | `{ userId }` → `{ viewSessionId, expiresAt, subject }` (audited) |
| DELETE | `/admin/view-sessions/:id` | End view mode |
| GET / PATCH | `/admin/settings` | Top-up limits, presets, max balance, low-balance threshold, reminder timings, quiet hours, approval requirement, debt reservation block |
| GET | `/admin/audit-logs` | `?actorId&entityType&entityId&from&to` |
| POST | `/admin/reconciliation/run` | Triggers the reconciliation job; returns the report |

### 2.7 Admin: users — `users`
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/users` | `?q=&status=&hasDebt=&sort=&page=&pageSize=`. Rows include balance and debt. |
| GET | `/admin/users/:id` | Profile, status, registration date, language, wallet, debt, counts |
| PATCH | `/admin/users/:id/status` | `{ status: "ACTIVE" \| "INACTIVE", reason }`. Deactivation revokes sessions. |
| GET | `/admin/users/:id/transactions` | Paged, filterable |
| GET | `/admin/users/:id/attendance` | |
| GET | `/admin/users/:id/trainings` | Reservations + attendance + charges |
| GET | `/admin/users/:id/payments` | Stripe payments |
| GET | `/admin/users/:id/debts` | |
| PUT / DELETE | `/admin/users/:id/standing-price` | `{ priceMinor }` (D5) |

### 2.8 Admin: wallets and transactions — `wallets`, `transactions`, `payments`, `debts`
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/wallets` | `?q=&hasDebt=&minBalance=&sort=-balance` |
| POST | `/admin/users/:id/cash-payments` | `{ amountMinor, description? }` + **Idempotency-Key** → CASH_TOP_UP (+ settlements). The UI shows a confirmation dialog first. |
| POST | `/admin/users/:id/adjustments` | `{ kind: "CREDIT" \| "DEBIT" \| "DEBT_WAIVER", amountMinor, reason }` + **Idempotency-Key** |
| POST | `/admin/users/:id/refunds` | `{ amountMinor, method: "STRIPE" \| "CASH", paymentId?, reason }` + **Idempotency-Key** (D17) |
| GET | `/admin/transactions` | `?type=&userId=&adminId=&method=&from=&to=&page=` |
| GET | `/admin/transactions/:id` | Full detail, including audit entries |
| POST | `/admin/transactions/:id/reversal` | `{ reason }` + **Idempotency-Key**. `409 ALREADY_REVERSED`. |
| GET | `/admin/payments` | `?status=` (incl. `REQUIRES_REVIEW`) |

### 2.9 Admin: trainings, pricing, reservations, attendance — `trainings`, `pricing`, `reservations`, `attendance`
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/trainings` | `?from&to&status&page` |
| POST | `/admin/trainings` | `{ title, description?, location, startsAt, endsAt, timezone, capacity?, defaultPriceMinor, reservationDeadline }` → notifies users |
| GET | `/admin/trainings/:id` | Detail + counts (attending / not / no response) + finalization state |
| PATCH | `/admin/trainings/:id` | Schedule changes notify ATTENDING users. Price edits do not affect existing charges. |
| POST | `/admin/trainings/:id/cancel` | `{ reason }`. Notifies users. If already finalized, auto-reverses charges (D12). |
| POST | `/admin/training-series` · PATCH · DELETE | Recurring definitions (D7) |
| GET | `/admin/trainings/:id/reservations` | All users with their response (incl. no response) |
| PUT | `/admin/trainings/:id/reservations/:userId` | Admin sets or overrides a response (may exceed capacity with `force: true`) |
| GET | `/admin/trainings/:id/prices` | Every user's **final resolved price** and its source |
| PUT / DELETE | `/admin/trainings/:id/price-overrides/:userId` | `{ priceMinor }` |
| GET | `/admin/trainings/:id/attendance` | Participant list (reserved + manually added) with status |
| PUT | `/admin/trainings/:id/attendance` | Bulk `[{ userId, status, note? }]`. Only while not finalized. Unknown users are added (walk-ins). |
| POST | `/admin/trainings/:id/attendance/finalize` | **Idempotency-Key**. Charges PRESENT users atomically. Rejects with `ATTENDANCE_HAS_PENDING` unless `{ pendingAs: "ABSENT" }` is given. |
| POST | `/admin/trainings/:id/attendance/:userId/correction` | `{ status, reason }` + **Idempotency-Key**. After finalization: reversal and/or new charge (D11). |
| GET | `/admin/attendance/queue` | Past trainings awaiting finalization |

### 2.10 Admin: reports — `reports`
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/reports/summary` | `?from&to`: top-ups by method, cash by admin, training revenue charged vs collected, debt created/settled/waived, refunds |
| GET | `/admin/reports/revenue` | `?from&to&groupBy=day\|week\|month` time series |
| GET | `/admin/reports/trainings` | Per-training: attendees, charged, collected, outstanding |
| GET | `/admin/reports/debts` | Aging buckets (0–30 / 31–60 / 60+ days), per user |
| GET | `/admin/reports/cash` | Cash collected per admin per period (cash-drawer reconciliation) |
| GET | `/admin/reports/*.csv` | CSV export of the same reports |

### 2.11 Webhooks and health
| Method | Path | Notes |
|---|---|---|
| POST | `/webhooks/stripe` | Raw body, signature verified. Handles `payment_intent.succeeded`, `.processing`, `.payment_failed`, `.canceled`, `charge.refunded`, `charge.dispute.created/closed`. Returns 2xx only after the event is durably stored. |
| GET | `/health/live` · `/health/ready` | Liveness; readiness (DB, Redis) |

---

## 3. Realtime (Socket.IO)
- **Handshake:** `auth: { token: accessToken }`, verified like REST. A socket is disconnected when its token expires; the client reconnects with the refreshed token.
- **Rooms:** `user:<id>` (own events), `admins` (operational events). View-as sessions do not join user rooms.
- **Server → client events** (payload = IDs only; the client refetches over REST):

| Event | Room | Client action |
|---|---|---|
| `wallet.updated` | user | invalidate `me.wallet`, `me.dashboard`, `me.transactions` |
| `payment.updated` | user | invalidate `me.payment(id)` |
| `notification.created` | user | invalidate `me.notifications`, unread count |
| `training.updated` | user / admins | invalidate training lists and detail |
| `reservation.updated` | admins | invalidate `admin.training(id).reservations` |
| `admin.activity` | admins | invalidate `admin.dashboard` |

---

## 4. Example: cash payment

```http
POST /api/v1/admin/users/0192f.../cash-payments
Authorization: Bearer eyJ...
Idempotency-Key: 6f1c2a2e-0d7b-4b7e-9a51-2b3c1d0e9f10
Content-Type: application/json

{ "amountMinor": 5000, "description": "Cash at Tuesday training" }
```
```jsonc
201 Created
{
  "data": {
    "transaction": {
      "id": "0193a...", "type": "CASH_TOP_UP", "status": "POSTED",
      "amount": { "amountMinor": 5000, "currency": "EUR" },
      "balanceBefore": { "amountMinor": 0, "currency": "EUR" },
      "balanceAfter":  { "amountMinor": 4600, "currency": "EUR" },   // after auto-settlement
      "paymentMethod": "CASH", "createdByAdminId": "0191...", "createdAt": "2026-11-24T18:42:10Z"
    },
    "debtSettlements": [ { "transactionId": "0193b...", "debtId": "0192c...", "amount": { "amountMinor": 400, "currency": "EUR" } } ],
    "wallet": { "balance": { "amountMinor": 4600, "currency": "EUR" }, "debt": { "amountMinor": 0, "currency": "EUR" } }
  },
  "meta": { "requestId": "req_01J..." }
}
```
Sending the same request again with the same key returns the identical `201` body and creates no new rows. The same key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
