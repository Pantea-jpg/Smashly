# 13 — Trying the app before launch (Render + Expo Go)

A low-cost way to try the whole app on an iPhone. You only need **Render**, **Expo** and **GitHub** accounts: no Stripe, Apple Developer account, email provider, storage or Sentry.

## What works and what doesn't in this setup

| Works | Not in this setup |
|---|---|
| Register, sign in, profile, language, dark mode | Online top-ups (no Stripe: the app says payments are unavailable) |
| Trainings: create, respond, attendance, finalize and charge | Push notifications (Expo Go cannot receive them) |
| Wallet: cash payments, adjustments, reversals, cash refunds, debt | Profile pictures (no storage) |
| Admin: users, View as User, finance, settings | Opening email links on the phone (copy the link from the logs instead) |
| Live updates between two phones | Apple Pay (needs a real build) |

## 1. Put the code on GitHub

Render deploys from a Git repository. Create a **private** repository on GitHub and push this project to it.

## 2. Create the test setup on Render

1. **Create the sign-in key.** On your computer, in the project folder, run `pnpm --filter @tw/api keys:generate` and copy the output.
2. **Create the Blueprint.** In Render: **New → Blueprint**, select the repository, and set the Blueprint path to **`render.test.yaml`** (not `render.yaml`).
3. **Enter the key.** Render asks for one value, `JWT_PRIVATE_KEY`. Paste the key.
4. **Wait for "Live".** The free API sleeps when unused, so the first request after a while takes about a minute.
5. **Check the server.** Open `https://tw-api-test.onrender.com/health/ready` (your exact URL is on the service page). It should show `"status":"ok"`.

**Cost:** the database, Redis and API are on Render's free plans. The free database expires after 30 days. The **worker** is the only paid part. It writes emails to its log and runs reminders and the nightly money check. You can delete it to keep everything free, but then emails and reminders stop.

## 3. Create the first admin

In Render → `tw-api-test` → **Shell**:
```sh
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='a long password' node dist/seed.js
```

## 4. Open the app in Expo Go on your iPhone

1. **On the iPhone:** install **Expo Go** from the App Store and sign in with your Expo account.
2. **On the computer:** in a terminal, in the project folder:
   ```powershell
   cd apps/mobile
   ```
   ```powershell
   npx expo login
   ```
   ```powershell
   $env:EXPO_PUBLIC_API_URL="https://tw-api-test.onrender.com"; npx expo start --tunnel
   ```
   Use your own API URL. `--tunnel` works even when the phone and computer are on different networks; Expo may ask to install a small helper the first time.
3. **Open the app.** Scan the QR code with the iPhone camera. It opens in Expo Go. Expo CLI and Expo Go must be signed in to the same account.
4. **Keep the computer running.** Expo Go loads the app from your computer, so the terminal must stay open while testing.

## 5. Things to try

1. Sign in as the admin and create a training that starts in about 10 minutes.
2. Register a member account in the app (sign out first, or use a second phone).
3. As the member, say "I'm coming".
4. As the admin: Users → the member → record a **€20 cash payment**. The member's wallet updates live.
5. Once the training has started: Trainings → the training → Attendance → mark present → **Finalize and charge**. The member's balance goes down by the price.
6. Try an **adjustment**, a **reversal** (Transactions → a cash entry) and a **cash refund**.
7. Charge more than the balance: the member sees the debt banner, and the next cash payment pays the debt first.
8. Switch language (Profile → Settings → Nederlands) and dark mode.
9. **Email links:** Render → `tw-worker-test` → Logs, search for `email not sent`. The verification or reset link is in `body`. Copy the token from it and use it on the API page `https://tw-api-test.onrender.com/api/docs` (`POST /auth/email/verify` or `/auth/password/reset`).

## 6. When you're done

Delete the project `training-wallet-test` in Render (all its services and the database). The real setup (`render.yaml`) is separate and unaffected.
