# 12 — Production launch checklist

The Phase 10 gate: production is launched when every box is ticked and the sign-off at the bottom is filled in.
- **✅ Done in the repository:** built and tested here.
- **☐ Needs your accounts or a real device:** steps in [09-deployment.md](09-deployment.md).

## Built and verified in the repository

- ✅ Render Blueprint for staging and production in Frankfurt: API, worker, PostgreSQL 17 with point-in-time recovery, Redis (`render.yaml`).
- ✅ Production image rehearsed locally:
  - migrations apply inside the image (Render's pre-deploy step);
  - the API and worker start from the same image;
  - `/health/ready` checks the database and Redis;
  - the version reported is the deployed commit.
- ✅ Release pipeline: CI → staging auto-deploy → smoke test; tag → full CI → approval → API (migrations first) → worker → smoke test → Sentry release.
- ✅ CI also scans for secrets (gitleaks), audits production dependencies (high and critical), and builds the image and applies migrations to an empty database.
- ✅ Weekly dependency updates (Dependabot).
- ✅ Alerts to Sentry (EU), with no personal data:
  - reconciliation mismatch;
  - payment held for review;
  - Stripe webhook failure;
  - background job failed;
  - job backlog (watched by the API, so it also fires when the worker is down);
  - unexpected 500s and job crashes.
- ✅ Crash reporting in the app (Sentry), with personal data stripped.
- ✅ New passwords are checked against known breaches (Have I Been Pwned, k-anonymity; accepted if the service is down).
- ✅ Orphaned profile pictures are cleaned up every hour (only ones over a day old that no profile uses).
- ✅ Admin **refund screen** (cash or card, with limits shown) — it was missing from the app until now.
- ✅ Backup restore check: `node dist/verify-restore.js`. It is read-only, runs the migrations and protections checks and the full money reconciliation, and was tested against a damaged copy.
- ✅ Runbooks: reconciliation, payment review, webhooks, jobs, refunds and disputes, incident, rollback, restore, secret rotation ([10-runbooks.md](10-runbooks.md)).
- ✅ iOS:
  - three app variants (dev, staging, production) with their own bundle ids and link schemes;
  - EAS build profiles;
  - privacy manifest;
  - interim icon and launch screen;
  - export compliance;
  - in-app account deletion (since Phase 4);
  - store texts (NL/EN), privacy answers and review notes ([11-app-store.md](11-app-store.md)).

## Accounts and configuration (you)

- ☐ Accounts created: GitHub, Render, Cloudflare R2 (EU), email provider with a verified domain, Stripe (NL, activated for live payments), Apple Developer Program, Expo, Sentry (EU).
- ☐ Render Blueprint created and all secrets entered, separately for staging and production ([09 §2–3](09-deployment.md)).
- ☐ Custom domain on the production API, with the URL in `apps/mobile/eas.json`.
- ☐ Stripe webhooks (test for staging, live for production) with the listed events; signing secrets in Render.
- ☐ Card, Apple Pay and iDEAL enabled in Stripe. Apple Pay merchant id and certificate set up.
- ☐ GitHub `production` environment with you as required reviewer, the deploy hooks, and `PRODUCTION_API_URL`. `STAGING_API_URL` variable set.
- ☐ Sentry alert rules: fatal issues → email; error bursts → email. Render failure notifications on.
- ☐ First admin created with `node dist/seed.js` in the Render Shell.
- ☐ The club's own app icon, if available. Replace `apps/mobile/assets/icon.png` and `splash-icon.png`, both 1024 × 1024.
- ☐ Privacy policy published, and its URL in App Store Connect.

## Checks on staging (with the staging TestFlight build)

- ☐ Staging smoke test green in GitHub Actions.
- ☐ The audit log shows your real public IP after signing in (confirms `TRUST_PROXY_HOPS=1`).
- ☐ Register, verify the email (the link opens the staging app), sign out and in, reset the password.
- ☐ Breached password refused on registration (try `Password123!`).
- ☐ Top-up with Stripe test cards: success, 3-D Secure (`4000 0025 0000 3155`), declined, and an iDEAL test payment; the wallet is credited once.
- ☐ Admin: cash payment, adjustment, reversal, a refund in cash, and a refund to card (Stripe test mode).
- ☐ Training: create, reserve as a member, mark attendance, finalize, then see the charge and the debt banner when the balance is short.
- ☐ Push on a real iPhone, in Dutch and English: new training, reminder, top-up confirmation; quiet hours respected; tapping opens the right screen. *(Phase 8 gate.)*
- ☐ Everything in TestFlight on a real iPhone: Apple Pay, the iDEAL return link, VoiceOver on the main screens, the largest Dynamic Type size. *(Phase 7 gate.)*
- ☐ Maestro smoke flows run on a simulator ([apps/mobile/.maestro](../apps/mobile/.maestro/README.md)).
- ☐ Startup and scrolling measured in Instruments: cold start under 1.5 s to the Home skeleton on an iPhone 12, and no dropped frames in a 200-row history ([07](07-performance.md)).
- ☐ A test alert reaches your email: use **Send Test Notification** on each Sentry alert rule.

## Production readiness

- ☐ First production deploy green; the production smoke test passes over HTTPS.
- ☐ Live Stripe: one real €5 top-up with your own card, then a refund to card from the admin app; both appear correctly.
- ☐ **Restore drill done:** a point-in-time restore of production into a new database, `verify-restore` reports `RESTORE OK`, and the drill database is deleted ([10 §8](10-runbooks.md)).
- ☐ Accountant has confirmed the revenue reporting split, top-ups versus training revenue (D20).
- ☐ Demo accounts for App Review created; App Store submission sent ([11](11-app-store.md)).

## Sign-off

| | Name | Date |
|---|---|---|
| Launch approved by | | |
| Restore drill performed by | | |
