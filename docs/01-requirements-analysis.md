# 01 — Requirements Analysis, Risks & Open Decisions

Status: **Draft for approval** · Phase 1 (Product Planning) · 2026-11-24

---

## 1. Scope summary

### In scope
| Area | Summary |
|---|---|
| Accounts | Two roles: `ADMIN`, `USER`. Register, login, password reset, profile, activation/deactivation. |
| View as User | Admin opens a **read-only** viewing context of any user's app. No impersonation. |
| Trainings | Admin-only CRUD, cancel, capacity, reservation deadline, default price, per-user price overrides. |
| Reservations | User answers *Attending* / *Not attending* until the deadline; capacity enforced. |
| Attendance | Admin marks `PRESENT / ABSENT / EXCUSED / PENDING`, then **finalizes**. Only `PRESENT` is charged. |
| Wallet | One wallet per user (EUR first). Immutable ledger. Online top-ups (Stripe), cash top-ups (admin), training charges, debt, refunds, adjustments, reversals. |
| Debt | Shortfall on a training charge becomes debt; auto-settled from later credits. Balance never negative. |
| Notifications | Push (APNs now, FCM later) + in-app history, preferences, read/unread, EN + NL, de-duplicated. |
| i18n | English + Dutch, device detection, manual override, localized dates and currency. |
| Platforms | iOS first. Architecture ready for Android and Web. |

### Explicitly out of scope
Teams, Clubs, Parents/guardians, Match management, group chat, general-purpose payments (P2P, withdrawals to bank, shop).

---

## 2. Interpretations and assumptions

These are the readings I used to design the system. Correct any that are wrong.

1. **One organization per deployment.** No clubs means one coach or business runs the platform (see decision **D1**).
2. **Admins have no wallet.** An admin account manages; it does not train or pay (see **D3**).
3. **Charging happens at attendance finalization**, not when a single row is marked PRESENT. Until finalization, attendance is a draft and has no financial effect.
4. **A reservation is intent, attendance is fact.** Charges come only from attendance. A user who never reserved can still be marked PRESENT (walk-in) and is charged.
5. **"Payment" in the requested entity list** is the record of an external payment attempt (Stripe PaymentIntent). The charge for a training is a separate entity, `TrainingCharge`.
6. **Debt is per charge**, so the user can see which training it came from and settlement can be allocated oldest-first.
7. **Wallet balance and debt are both tracked in the same ledger row.** Each row records the balance and the debt before and after. That way every financial event, including debt creation, has exactly one immutable ledger record.
8. **The top-up amount is chosen by the user**, but the server validates it (integer minor units, min/max, allowed currency). The server computes every other amount: prices, charges, settlements, reversals.

---

## 3. Architectural risks

| # | Risk | Impact | Mitigation built into the design |
|---|---|---|---|
| R1 | **Double credit or double charge** from retried requests, duplicate webhooks, double-taps, or concurrent finalization | Real money lost or gained; loss of trust | One **ledger service** is the only write path. A row lock on the wallet (`SELECT … FOR UPDATE`). A unique `idempotencyKey` on every ledger row (`stripe_pi:<id>`, `charge:<training>:<user>:<n>`, client `Idempotency-Key`). A unique Stripe event ID. A partial unique index on active charges. |
| R2 | **Lost updates and race conditions** on the balance | Wrong balances | The balance is changed only inside the locked transaction, together with a per-wallet `sequence` (unique `(walletId, sequence)`). DB `CHECK (balance >= 0 AND debt >= 0)`. Wallets are locked in a deterministic order (by id) so multi-wallet operations cannot deadlock. |
| R3 | **Ledger tampering or accidental edits** | Audit failure | DB trigger blocks `UPDATE`/`DELETE` on `wallet_transactions`. The app DB role has no `DELETE` on financial tables. Corrections are made only through `REVERSAL` / `ADJUSTMENT` rows. |
| R4 | **Cached balance drifts from the ledger** | Silent inaccuracy | Invariant: `wallet.balance = Σ walletDelta`, `wallet.debt = Σ debtDelta = Σ open debt outstanding`. A nightly **reconciliation job** checks this and alerts on any mismatch. Property-based tests cover the domain math. |
| R5 | **Asynchronous Stripe flows**: iDEAL redirects, delayed or out-of-order webhooks, app killed mid-payment | Users see "paid" but no credit, or credit twice | The wallet is credited **only from a verified webhook**. A `Payment` state machine handles status. The client polls or listens over the socket for the final status. A sweeper re-checks `PROCESSING` payments older than N minutes against the Stripe API. |
| R6 | **Refund or chargeback of a top-up that was already spent** | A negative balance would be needed | The balance may never go negative, so the shortfall must become debt or be absorbed. This is a policy question: **D18**. |
| R7 | **Attendance corrections after finalization** | Must undo or redo charges and debt correctly | Corrections go through a dedicated endpoint that atomically posts a `REVERSAL` (returning what was actually paid, cancelling the open debt) and, when needed, a new charge. The prior state is never edited in place. |
| R8 | **View-as data leaks or accidental writes** | Privacy breach; admin mutating user data | The server-side **view context** blocks every non-`GET` request globally, before routing. The admin identity is never replaced. Every view session is audited. Socket rooms are not joined. "Mark as read" is a `POST`, so it is blocked too. |
| R9 | **Regulatory: stored value / e-money (EU EMD2, NL DNB)** | Licensing obligations | A closed-loop wallet usable only for this business's own trainings normally falls under the *limited network* exclusion. **Have this confirmed by a legal advisor.** The architecture keeps the wallet single-purpose: no P2P, no withdrawal to bank. |
| R10 | **Tax: prepaid balances and VAT** (EU voucher rules), Dutch 7-year bookkeeping retention | Wrong revenue reports | Reports separate *top-ups* (liability) from *training revenue* (charges). An accountant must confirm when VAT applies (**D20**). Ledger rows are retained for 7 or more years. |
| R11 | **App Store review** | Rejection | Paying for real-world services (training sessions) with Stripe is allowed: in-app purchase is not required for physical services. Prepare review notes. **Apple requires in-app account deletion**: implement it as PII anonymization while the financial records are retained (see the Database doc, §7). |
| R12 | **GDPR**: PII, admin access to profiles, push tokens | Fines, trust | EU-region hosting. View-as and admin reads are audited. Data export endpoint. Anonymize on deletion. Minimal PII in logs (redaction in the pino config). |
| R13 | **Timezones and DST** (Europe/Amsterdam) | Trainings shifted by an hour; wrong deadline | Store `timestamptz` (UTC) plus an IANA `timezone` per training. Format on the device with `Intl`. Never store local wall-clock strings. |
| R14 | **Capacity races** (two users take the last spot) | Overbooking | Lock the training row when switching to ATTENDING, then count inside the transaction. |
| R15 | **Refresh token theft** | Account takeover | Opaque refresh tokens stored hashed. **Rotation with reuse detection** (reuse revokes the whole token family). iOS Keychain storage. Short 15-minute access tokens. Per-request check of user status. |
| R16 | **Admin UX on a phone**: 8 sections plus financial reports | Cramped, error-prone | Group them into 5 tabs (see Architecture §4). Design the API so a web admin can be added without backend changes (**D24**). |
| R17 | **Later move to multi-tenant SaaS** | Painful retrofit of every table and query | Decide now (**D1**). If there is any chance of it, add `organizationId` from day one. |
| R18 | **Single Postgres as source of financial truth** | Data loss | Managed Postgres with point-in-time recovery, daily snapshots, and tested restores. Migrations are reviewed and forward-only in production. |

---

## 4. Open business decisions

Rule 16 says I must not invent financial behaviour, so every item below has a **recommended default**. You can answer just "accept defaults", or override individual items.
Items marked **⛔ DB** affect the schema and should be settled before Phase 3.

### A. Tenancy and accounts
| ID | Question | Why it matters | Recommendation |
|---|---|---|---|
| D1 ⛔ DB | One business per deployment, or a multi-tenant SaaS for many coaches/businesses? | Every table and query changes | **Single-tenant for v1**. If you plan to sell it to multiple businesses, say so now and I'll add `organizationId` everywhere. |
| D2 | Open self-registration, or invite/approval only? Is email verification required? | Strangers creating accounts and reserving spots | **Open registration + email verification.** New accounts start `ACTIVE`. An optional setting "require admin approval" puts them in `PENDING_APPROVAL`. |
| D3 ⛔ DB | Can an admin also be a trainee with a wallet? Multiple admins? Different admin permission levels? | Role model | **Roles are exclusive; multiple admins allowed; all admins equal in v1.** (Use a separate USER account to train.) |
| D4 | When a user is deactivated or deletes their account while holding a balance or debt? | Customer money | **Block self-deletion while balance > 0 or debt > 0.** Admin settles first (refund/waive). Deactivation keeps the wallet intact. |

### B. Pricing
| ID | Question | Why it matters | Recommendation |
|---|---|---|---|
| D5 ⛔ DB | Individual pricing scope. The spec's example ("User B: €12") could mean (a) per training only, or (b) a standing personal price used for every training. | Admin workload; schema | **Both levels**: an optional *standing user price* plus a *per-training override*. Resolution order: training override → user standing price → training default. |
| D6 | When is the price locked? At reservation, at deadline, or at charge (finalization)? | What a user agreed to vs what they pay | **Charge at the price in effect at finalization** (snapshotted on the charge). Notify users who reserved when their price changes. |
| D7 ⛔ DB | Recurring trainings (e.g. every Tue 19:00)? | Without it, admins create each session by hand | **Yes, add a `TrainingSeries`** that generates individual sessions. Each session can then be edited on its own. Scheduled for Phase 6. |

### C. Reservations and attendance
| ID | Question | Why it matters | Recommendation |
|---|---|---|---|
| D8 | Late cancellation or no-show fee? (The spec says ABSENT = no fee.) | Revenue policy | **No fee (as specified).** The design can add it later as a separate charge type. |
| D9 ⛔ DB | Waitlist when a training is full? | Capacity handling | **No waitlist in v1.** The admin can override capacity. Waitlist later. |
| D10 | Can users with outstanding debt still reserve? | Debt growth | **Allowed, with a warning**, plus an optional admin setting "block reservations when debt > €X". |
| D11 | Can attendance be corrected after finalization? By whom? | Financial corrections | **Yes, by admins, with a mandatory reason**, through reversal plus re-charge (R7). |
| D12 | A training is cancelled after charges were posted? | Refund flow | **Automatically reverse all its charges** (returning paid amounts to wallets and cancelling the open debt). |
| D13 | Auto-finalize if the admin forgets? | Unbilled sessions | **No auto-finalize.** Remind admins after 24 h, and show "awaiting finalization" on the dashboard. |

### D. Wallet and money
| ID | Question | Why it matters | Recommendation |
|---|---|---|---|
| D14 | Top-up limits and presets? Maximum balance? | Fraud, regulation | **Min €5, max €500 per top-up, max balance €1,000.** Presets €10 / €25 / €50 / €100 plus a custom amount. All configurable in Settings. |
| D15 | Who pays Stripe fees? Which methods? | Net revenue; Dutch users expect iDEAL | **The business absorbs fees** (credit = amount paid). Methods: **card, Apple Pay, iDEAL** (iDEAL is the dominant payment method in the NL). |
| D16 ⛔ DB | Debt allocation policy for incoming funds | Spec asks for a defined policy | **FIFO, oldest debt first, automatically on every wallet credit** (online, cash, positive adjustment, reversal credit). Partial settlement allowed. |
| D17 | Can users get unused balance refunded? How? | Consumer law; cash flow | **Admin-initiated only.** Refund to the original card via Stripe (up to the top-up's refundable amount) or record a cash refund. Users request it via a support contact. |
| D18 ⛔ DB | A top-up is refunded or charged back after the money was spent | Balance cannot go negative | **Deduct up to the available balance; the remainder becomes debt** (`Debt.source = TOP_UP_REVERSAL`). |
| D19 | Admin adjustments and debt waivers? Approval rules? | Fraud risk inside the business | **Allowed, with a mandatory reason, fully audited.** No two-person approval in v1 (can add a threshold later). |
| D20 | Revenue recognition in reports | Accounting/VAT correctness | Report **"Training revenue (charged)"** and **"Collected"** separately. Top-ups are shown as wallet funding, not revenue. **Please confirm with your accountant.** |
| D21 | "Low wallet balance" definition | Notification spam | **Balance < €10 (configurable)**, at most one alert per 7 days. |

### E. Notifications
| ID | Question | Recommendation |
|---|---|---|
| D22 | Reminder timing, debt reminder cadence, quiet hours? | **Training reminder 24 h before, plus 2 h before for ATTENDING users. Debt reminder weekly. No pushes 22:00–08:00 local**, except payment confirmations. |
| D23 | Can users disable payment notifications? | **In-app history is always kept. Push is toggleable per category** (Trainings, Payments, Reminders). |

### F. Platform and operations
| ID | Question | Recommendation |
|---|---|---|
| D24 | Admin on mobile only, or a web admin later? | **Mobile admin in v1. The API is web-ready.** A web admin can be added in a later phase (financial reports are better on a large screen). |
| D25 | Use Expo (with development builds/EAS), or bare React Native CLI? | **Expo.** It is the React Native team's recommended framework: managed native config, EAS iOS builds and submissions, first-class Stripe and notifications modules, and a straight path to Android and Web. Native code remains possible through config plugins. |
| D26 | Hosting, email provider, region | **EU region.** Managed Postgres plus a container host (e.g. AWS eu-central-1 or a PaaS such as Render/Fly in the EU). Transactional email via Postmark/SES. S3-compatible storage for avatars. |
| D27 | Accounts you need to create (I cannot create them for you) | Apple Developer Program, Stripe account (NL), APNs key, email provider, hosting, Sentry. Needed by Phase 5 (Stripe) and Phase 10 (iOS). |
