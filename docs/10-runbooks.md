# 10 — Runbooks

What to do when something goes wrong.
- **Who it is for:** whoever is on call (at first, you), with help from a developer when a step says so.
- **Golden rule:** **money is never corrected by editing the database.** Every correction is a ledger entry (adjustment, reversal or refund) with a reason, made in the admin app.

| Alert or situation | Section |
|---|---|
| Sentry `reconciliation_mismatch` | [1](#1-reconciliation-mismatch) |
| Sentry `payment_requires_review` | [2](#2-payment-held-for-review) |
| Sentry `stripe_webhook_failed` | [3](#3-stripe-webhook-failures) |
| Sentry `outbox_event_failed` / `outbox_backlog` | [4](#4-background-jobs-stuck-or-failing) |
| Member asks for a refund, or a chargeback arrives | [5](#5-refunds-and-disputes) |
| App down, errors everywhere | [6](#6-incident-the-app-is-down-or-erroring) |
| A bad release | [7](#7-roll-back-a-release) |
| Data lost or corrupted; quarterly drill | [8](#8-restore-a-backup-and-the-quarterly-drill) |
| A key leaked or a staff member leaves | [9](#9-rotate-a-secret) |

## 1. Reconciliation mismatch

**What it means:**
- The nightly money check recomputed a wallet from its ledger rows and got a different balance or debt than the stored total. Or a payment, charge or debt did not add up.
- Members still see the stored total, and **nothing is corrected automatically**.

**What to do:**
1. **See the details.** The admin dashboard shows the number of issues under "Needs attention". The Sentry issue lists the first 20 with the affected wallets. A developer can re-run the check at any time with `POST /api/v1/admin/reconciliation/run` (admin token), which returns every issue.
2. **Check whether money moved.** Usually a code bug or a manual database change caused it. Compare with the member's transaction history in the admin app.
3. **Ask a developer before correcting anything.** They find the cause and fix it, then correct the wallet with an **adjustment** (with a reason that references the Sentry issue).
4. **Confirm the fix.** Run the check again until it reports no issues. The dashboard count goes back to zero.

**Don't:** edit `wallets` or `wallet_transactions` in the database. The ledger is append-only, and the database refuses changes to it on purpose.

## 2. Payment held for review

**What it means:** Stripe reports a top-up as paid, but for a different amount or currency than the app created. The app did **not** credit the wallet.

**What to do:**
1. **Check the payment in Stripe.** The admin dashboard counts payments that need review. The Sentry issue names the payment and the amounts. Open the same payment in the Stripe dashboard (search for the member's email or the amount).
2. **If the member really paid:** credit the amount Stripe actually received with an **adjustment**, with a reason such as "Stripe pi_… received €X".
3. **If it is wrong:** refund it in Stripe. The refund webhook books it automatically.

## 3. Stripe webhook failures

**What it means:**
- A verified Stripe event could not be processed: a database problem, or a bug. Stripe retries for up to 3 days. The event and its error are stored in `stripe_events.error`.
- The payment sweeper also asks Stripe every 5 minutes about payments that are still open, so top-ups are credited even if webhooks keep failing.

**What to do:**
1. **Read the error.** The Sentry issue shows the event type and the error.
2. **Temporary cause** (database restarting, deploy): nothing to do. The retry succeeds, and Sentry shows no new events.
3. **Error that keeps repeating:** a developer fixes it and releases. Then Stripe → Developers → Webhooks → the event → **Resend**.
4. **Signature failures in the API logs** ("invalid signature"): check that `STRIPE_WEBHOOK_SECRET` on the API matches the endpoint in Stripe.

## 4. Background jobs stuck or failing

**What it means:**
- **`outbox_backlog`:** jobs (emails, pushes) have waited more than 15 minutes. The worker is down or stuck.
- **`outbox_event_failed`:** one job failed 10 times and was given up.

**What to do:**
1. **Check the worker.** Render → `tw-worker-production` → is it running? Read the last logs. Restart it if it crashed (**Manual Deploy → Restart**).
2. **Failed emails:** usually an SMTP problem (provider outage, expired password). Fix `SMTP_URL`, then redeploy the worker.
3. **Failed pushes:** usually an APNs key problem ("InvalidProviderToken"). Check `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_PRIVATE_KEY`.
4. **Retry jobs that were given up.** A developer can retry them:
   ```sql
   UPDATE outbox_events SET failed_at = NULL, attempts = 0, available_at = now()
   WHERE failed_at > now() - interval '1 day';
   ```

## 5. Refunds and disputes

**Refund of unused balance (D17):**
- **To the card:** admin app → member → **Refund** → "To card", then choose the top-up. The screen shows how much of each top-up is left. The money goes back through Stripe, and the wallet is debited at once.
  - If the bank later reports the refund as failed, the wallet is credited back automatically.
  - Only the unused balance can be refunded, up to the amount of that top-up.
- **In cash:** admin app → member → **Refund** → "In cash", with a reason. The admin hands over the money.

**Chargeback** (the member's bank disputes a card payment):
1. **Stripe withdraws the money.** The app debits the wallet automatically. Whatever the wallet does not cover becomes debt, and the payment shows "Disputed".
2. **Respond in the Stripe dashboard within the deadline.** Useful evidence: the member's transaction history (admin app → member → Transactions) and their attendance.
3. **If you win,** Stripe returns the money and the app credits it back automatically. **If you lose,** the debt stays. Decide whether to waive it with a **debt waiver** adjustment.

**Training cancelled after charging:** cancelling a finalized training in the app refunds every charged member to their wallet automatically.

## 6. Incident: the app is down or erroring

1. **Get the facts.**
   - Is it everyone or one member?
   - Render dashboard: are the services up, and is the last deploy green?
   - Open `https://<api>/health/ready` to check the database and Redis.
   - Sentry: what started when?
2. **Was there a deploy in the last hour?** Roll back (section 7).
3. **Database or Redis down:** check Render's status page, since Render restores managed services itself. The app returns errors but loses no money: every money operation is one database transaction, which either completes or doesn't happen.
4. **Tell members if it lasts more than about 15 minutes** (club WhatsApp or email): "Payments and bookings are temporarily unavailable; nothing is lost."
5. **Afterwards:** write five lines: what happened, impact, cause, fix, prevention. Add them to `docs/incidents/` (create the folder on the first incident).

**Personal-data breach:** if member data may have leaked, the Dutch Data Protection Authority (Autoriteit Persoonsgegevens) must be notified **within 72 hours** (GDPR art. 33). Note the time you found out.

## 7. Roll back a release

- **Fastest:** Render → `tw-api-production` → **Events** → the previous successful deploy → **Rollback**. Then do the same for `tw-worker-production`.
- **Migrations are not undone by a rollback.** That is safe because migrations are written "expand, then contract": the previous version still works with the new schema.
- **If a migration itself is broken:** stop. A developer writes a new forward migration. Never delete rows from `_prisma_migrations` by hand.
- **Fix forward:** after a rollback, fix on `main`, verify on staging, and tag a new version.

## 8. Restore a backup, and the quarterly drill

Render keeps daily backups and point-in-time recovery: 3 days on a Hobby workspace, 7 days on Pro, and not to a time within the last 10 minutes.

**Restore drill: every quarter, and before launch**
1. **Create the restored copy.** Render → `tw-db-production` → **Recovery** → choose a time → restore into a **new** database (for example `tw-db-restore-drill`). Production is not touched.
2. **Run the check.** Open the **Shell** of `tw-api-production` and run the read-only check against the copy:
   ```sh
   DATABASE_URL='<internal URL of tw-db-restore-drill>' node dist/verify-restore.js
   ```
   The check:
   - connects read-only (enforced by PostgreSQL);
   - checks that all migrations are applied and the money-protection triggers are present;
   - runs the full money reconciliation;
   - prints row counts and the newest ledger, audit and sign-in times.

   It ends with `RESTORE OK` or the list of problems.
3. **Record the result.** Note the date, how long the restore took, and whether the newest ledger entry matches the chosen time. Add it to `docs/restore-drills.md` (create it on the first drill).
4. **Delete the drill database** (it costs money).

**A real restore** (data lost or corrupted):
1. Put the app in maintenance: suspend `tw-worker-production`, so no jobs run on the wrong data. Scale `tw-api-production` to 0, or show a status message.
2. Restore to the last good time into a new database, and run `verify-restore` as above.
3. Point both services' `DATABASE_URL` at the restored database (Render → Environment), redeploy, and run the smoke test.
4. **Stripe events after the restore time:** Stripe → Webhooks → resend the events since then. The app handles each event once, so resending is safe. The sweeper also catches paid top-ups.
5. Tell members which time the data was restored to. Cash payments recorded after that time must be entered again from the paper or receipt trail.

## 9. Rotate a secret

| Secret | How |
|---|---|
| `JWT_PRIVATE_KEY` (sign-in tokens) | Generate a new key. Set the old **public** key as `JWT_PREVIOUS_PUBLIC_KEY` with its id in `JWT_PREVIOUS_KEY_ID`. Set the new key with a new `JWT_KEY_ID`. Redeploy the API and worker. After 15 minutes (the access-token lifetime), remove the previous key. Members stay signed in. |
| Stripe keys / webhook secret | Roll the key in Stripe, update the API and worker, and redeploy. |
| APNs key | Create a new key, update the three `APNS_*` values, redeploy the worker, and revoke the old key in Apple Developer. |
| R2 / SMTP / Sentry | Create a new token in the provider, update the service environment, redeploy, then delete the old token. |
| An admin leaves | Admin app → Users → deactivate them. Their sessions end at once. Then rotate any secret they had access to. |
