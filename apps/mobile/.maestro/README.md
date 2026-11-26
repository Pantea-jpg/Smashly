# Maestro end-to-end smoke flows (iOS simulator)

These flows drive the real app on an iOS simulator: tap, type, scroll, and check what is on screen.
They complement the Jest tests (which use a mocked API) by running against a real API and database.

| Flow                           | What it checks                                                                                     | Tags                |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------- |
| `member-wallet.yaml`           | Sign in, balance on Home, wallet history, transaction detail, scrolling loads more pages, sign out | smoke, member       |
| `member-reserve-training.yaml` | Open the next training, "I'm coming", then "Not coming"                                            | smoke, member       |
| `member-language.yaml`         | Switch to Dutch and back; tab labels change at once                                                | smoke, member, i18n |
| `admin-cash-payment.yaml`      | Find a member, record €5 cash with the confirmation dialog, balance changes                        | smoke, admin, money |
| `admin-attendance.yaml`        | Attendance queue, mark present, finalize and charge                                                | smoke, admin, money |
| `member-top-up.yaml`           | €10 top-up through the Stripe PaymentSheet with Stripe's **test** card                             | member, stripe      |

## What you need

- A Mac with Xcode and an iOS simulator, plus a **development build** of the app installed on it
  (`npx expo run:ios`, or an EAS development build). Expo Go cannot run Stripe or push.
- Maestro: `curl -fsSL "https://get.maestro.mobile.dev" | bash`
- The API running locally with the demo members (`SEED_DEMO_USERS=true pnpm --filter @tw/api db:seed`).
  The seed creates no trainings, so before the first run, as the admin in the app:
  - create one upcoming training (for `member-reserve-training.yaml`);
  - create a training that starts in a few minutes, answer "I'm coming" as the member, and run
    `admin-attendance.yaml` once it has started (it needs a started, unfinalized training).
  - give the member some balance (a cash payment) so the wallet history is not empty.
- For `member-top-up.yaml` only: Stripe **test** keys in `apps/api/.env` and
  `stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe` running. Never production keys.

## Running

Credentials are passed on the command line, never written in these files. The member must use the
English app language (for example the seeded `olivia.smith@example.test`), because the
confirmation dialogs are matched by their English button text.

```sh
cd apps/mobile
maestro test .maestro --include-tags smoke \
  -e MEMBER_EMAIL=olivia.smith@example.test -e MEMBER_PASSWORD="$SEED_DEMO_PASSWORD" \
  -e ADMIN_EMAIL="$SEED_ADMIN_EMAIL" -e ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD"
```

Add `member-top-up.yaml` (or `--include-tags stripe`) when Stripe test mode is set up.
`maestro studio` opens an inspector that shows every element's `testID` while you write new flows.

## Writing flows

- Select elements by `id` (the React Native `testID`). Tabs have `tab-home`, `tab-trainings`,
  `tab-wallet`, `tab-notifications`, `tab-profile` (members) and `tab-dashboard`, `tab-users`,
  `tab-admin-trainings`, `tab-finance`, `tab-more` (admins).
- Lists use ids with the record id (`training-<id>`, `tx-<id>`): match them with a regex
  (`'training-.*'`) and `index: 0`.
- Status: written in Phase 9, **not yet run**. They need macOS and a simulator build, which this
  Windows workspace does not have. The first run is part of the Phase 10 device checks.
