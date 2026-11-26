# 11 — App Store submission

Everything App Store Connect asks for, ready to paste. Placeholders like `<club>` are yours to fill in.

## App information

| Field | Value |
|---|---|
| Name | Training Wallet (or `<club>` Training) |
| Subtitle (30 characters) | EN: *Trainings and wallet in one* · NL: *Trainingen en saldo in één* |
| Category | Primary **Sports**, secondary **Health & Fitness** |
| Age rating | 4+ (no objectionable content; answer "No" to every question) |
| Bundle id | `com.trainingwallet.app` |
| Price | Free |
| Availability | Netherlands (add countries later as needed) |
| Privacy policy URL | **Required.** Host the club's privacy policy, for example `https://<club-site>/privacy`. Cover the data in the privacy table below, Stripe as payment processor, Sentry for crash reports, and the right to deletion. |
| Support URL | A contact page or `mailto:` page on the club's website |

## Description

**English**

> Book your trainings and keep track of your training wallet, all in one app.
>
> • See upcoming trainings and tell your coach whether you're coming
> • Top up your wallet with iDEAL, Apple Pay or card
> • Every training, payment and refund in a clear history
> • Reminders before your training, and a notice when your balance runs low
> • In English and Dutch, with dark mode
>
> For members of `<club>`. Your trainer records attendance; the training fee is taken from your wallet automatically.

**Nederlands**

> Meld je aan voor trainingen en houd je trainingssaldo bij, allemaal in één app.
>
> • Bekijk komende trainingen en geef aan of je komt
> • Waardeer je saldo op met iDEAL, Apple Pay of kaart
> • Elke training, betaling en terugbetaling overzichtelijk in je geschiedenis
> • Herinneringen voor je training en een melding als je saldo bijna op is
> • In het Nederlands en Engels, met donkere modus
>
> Voor leden van `<club>`. Je trainer registreert de aanwezigheid; het trainingsgeld gaat automatisch van je saldo af.

**Keywords (100 characters):**
- EN: `training,wallet,sports club,booking,attendance,iDEAL,team,coach,fitness,membership`
- NL: `training,saldo,sportclub,aanmelden,aanwezigheid,iDEAL,team,trainer,sport,lidmaatschap`

## Screenshots

- **Required size:** 6.9" iPhone (1320 × 2868). App Store Connect scales them to the smaller sizes.
- **Five screens:** Home (wallet card), the trainings list, a training detail with "I'm coming", the wallet history, and top-up.
- **How to take them:** use the staging build with demo data, in light mode, in both languages (one set per localization).

## App privacy ("nutrition label")

Matches the privacy manifest in `apps/mobile/app.config.ts`. Payment info is declared by Stripe's SDK in its own privacy manifest, which Xcode merges in.
- **Tracking:** none.
- **Shared with data brokers or advertisers:** nothing.

| Data type | Collected | Linked to the member | Purpose |
|---|---|---|---|
| Contact info → Name | Yes | Yes | App functionality |
| Contact info → Email address | Yes | Yes | App functionality (sign-in, receipts, password reset) |
| Contact info → Phone number | Optional | Yes | App functionality (club contact) |
| User content → Photos | Optional (profile picture) | Yes | App functionality |
| Financial info → Payment info | Yes, by Stripe's payment sheet inside the app | Yes | App functionality (top-ups). Card numbers go to Stripe, never to the club's servers. |
| Purchases → Purchase history | Yes (top-ups, training charges) | Yes | App functionality |
| Identifiers → User ID | Yes | Yes | App functionality |
| Identifiers → Device ID | Yes (push notification token) | Yes | App functionality (notifications) |
| Diagnostics → Crash data | Yes (Sentry, EU) | No | App functionality (fixing crashes) |

## Notes for App Review

Paste this in App Review Information → Notes, and fill in the demo accounts:

> **What the app is:** a members' app for `<club>`, a sports club in the Netherlands. Members book physical training sessions at the club and pay for them from a prepaid training wallet.
>
> **Payments (Guideline 3.1.5(a)):** the wallet only pays for physical training sessions that take place at the club, in person. That is a service consumed outside the app, so top-ups use Stripe (card, Apple Pay, iDEAL) rather than in-app purchase. Nothing digital is sold or unlocked in the app.
>
> **Demo accounts** (on our production system, with test data):
> • Member: `review-member@<club-domain>` / `<password>`. Has a balance, upcoming trainings and history.
> • Admin: `review-admin@<club-domain>` / `<password>`. Admin tabs: users, trainings, attendance, finance.
> Top-ups with the demo member use Stripe's live mode; please don't complete a real payment. The top-up screen and payment sheet can be opened and cancelled.
>
> **Account deletion (5.1.1(v)):** Profile → Delete account. The account is deleted in the app; financial records are kept anonymously as Dutch bookkeeping law requires.
>
> **Push notifications** are optional. The app asks only when the member taps "Turn on" on the Home screen or in Profile → Notifications.

**Before submitting:**
- Create both demo accounts in production; the admin account is created with the seed or by an existing admin.
- Give the demo member a cash top-up, and create two upcoming trainings.
- Remove the demo accounts' balance after approval, if needed.

## Export compliance

Uses only standard encryption (HTTPS/TLS), so it is exempt. This is already declared in the app (`usesNonExemptEncryption: false`), so App Store Connect does not ask on every build.
