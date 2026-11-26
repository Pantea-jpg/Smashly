# ADR 0005: Trainings, reservations, attendance and charging (Phase 6)

- **Status:** Accepted
- **Date:** 2026-11-24

## Trainings
- **Create:** the reservation deadline is optional and defaults to the start time. The database checks that the end is after the start, the deadline is not after the start, the price is ≥ 0 and the capacity is > 0. Active members get a `TRAINING_CREATED` notification.
- **Edit:**
  - Attendees are told about changes to the start, end, location or timezone (`TRAINING_UPDATED`).
  - A price change only notifies attendees whose own price actually changes (D6). Members with an override or a standing price are not bothered.
  - If the deadline was "until the start", moving the start moves the deadline with it.
  - After finalization, only title, description and location can change. Price, times and capacity are locked because the charges are snapshots.
- **Cancel (D12):** done under the training row lock. If attendance was already finalized, every active charge is reversed through `LedgerService.reverseTrainingCharge`: what was paid goes back to the wallet and open debt is cancelled. Attendees and charged members are notified, with `refunded: true` when money moved.
- **Delete** is only possible for a training nobody responded to or attended (soft delete). Anything else must be cancelled, so history is never lost.

## Recurring series (D7)
- **Rules:** the RRULE subset supported is `FREQ=WEEKLY;INTERVAL=n;BYDAY=…`. The API takes `weekdays` and `intervalWeeks` and stores the RRULE.
- **Times:** each occurrence is a local date plus a local start time in the series' IANA timezone, converted to UTC with `Intl`. Tuesday 19:00 therefore stays 19:00 in Amsterdam across both DST changes; unit and integration tests cover 29 March 2026. A time inside the spring-forward gap moves forward.
- **Generation:**
  - Sessions are generated 12 weeks ahead, never in the past, and an hourly worker job keeps the window rolling.
  - Generation continues after the last session ever generated, deleted ones included, so a removed session never comes back.
  - A partial unique index on `(series_id, starts_at)` makes double generation impossible.
- **Editing a series** changes the series and its future scheduled sessions. Each session can still be edited on its own afterwards.
- **Ending a series** (moving `endsOn` earlier, or deleting the series) affects only future sessions: those nobody touched are removed, and those with responses are cancelled with a notification. Past sessions are never changed.

## Reservations
- **Capacity under concurrency:** a member's `PUT /me/trainings/:id/reservation` locks the training row (`SELECT … FOR UPDATE`), then checks capacity, so concurrent requests cannot overfill. Test: 15 members, capacity 5, 5 succeed and 10 get `TRAINING_FULL`.
- **Other checks:** the training must not be cancelled or finalized, the deadline must not have passed (`now >= deadline` is refused, tested to the millisecond), and the account must be an active member. Admins have no wallet and get 403.
- **Idempotent:** sending the same status again changes nothing, and switching to `NOT_ATTENDING` frees the spot.
- **Debt (D10):** reserving with debt is allowed and returns `warning: OUTSTANDING_DEBT`. The admin setting `reservationDebtBlockMinor` (default `null`, meaning never block) refuses ATTENDING above the limit with `RESERVATION_BLOCKED_BY_DEBT`. Saying "not attending" is always possible.
- **Admin overrides:** admins can set a response after the deadline, and can exceed capacity with `force: true`. The member is notified, and the change is audited.

## Pricing (D5, D6)
- **Resolution order:** training override (0 = free) → member's standing price → training default. This is a pure function (`domain/pricing.ts`).
- **Price lists:** `GET /admin/trainings/:id/prices` shows every relevant member's final price and where it comes from.
- **Audit and notifications:** override and standing-price changes are audited. An attendee whose price changes before finalization is notified.
- **Snapshot:** the price is copied onto the `TrainingCharge` at finalization. Later edits to overrides, standing prices or the default never change existing charges (tested).

## Attendance and finalization
- **Marking:** possible from the training's start until finalization. Bulk updates are accepted. Members who were not reserved are added as walk-ins; non-members are rejected.
- **Finalization is one transaction under the training row lock:**
  1. Members who are ATTENDING but have no attendance row get a PENDING row.
  2. If anyone is PENDING, finalization is refused with `ATTENDANCE_HAS_PENDING` (with the count), unless `pendingAs: "ABSENT"` is sent.
  3. Every PRESENT member is charged at their resolved price, in user-id order.
  4. The training becomes `COMPLETED`.

  Either everyone is charged or nobody is.
- **Who pays:** only PRESENT members are charged; ABSENT and EXCUSED never are (D8: no no-show fee). A shortfall becomes debt: this is the €10 / €6 example (€6 paid, €4 debt).
- **No double charging:**
  - The endpoint requires an `Idempotency-Key`; a replay returns the stored response.
  - A second finalization with a different key gets `ATTENDANCE_FINALIZED`.
  - Five concurrent finalizations produce exactly one success.
  - The partial unique index on active charges is the last line of defence.
- **Corrections (D11):** an admin can correct attendance after finalization, with a reason and an Idempotency-Key.
  - PRESENT → ABSENT or EXCUSED reverses the charge.
  - Not present → PRESENT charges at the price that applies now.
  - Correcting to the same state does nothing.
  - Every correction is audited.
- **D13:**
  - `GET /admin/attendance/queue` lists ended, unfinalized trainings, oldest first, with pending and present counts.
  - A worker job sends each admin one `ATTENDANCE_FINALIZATION_REMINDER` per training, 24 hours after it ends.
  - There is no automatic finalization.

## History
- `GET /me/attendance` lists every training the member has an attendance row or a charge for, even one finalized before it ended. The Phase 6 gate test caught that gap.
- `GET /admin/users/:id/trainings` shows a member's response, attendance and charge for each training.
- `GET /me/trainings` takes `scope=upcoming|past`, uses a cursor, and returns the member's price, response, attendance and charge for each training.

## Phase gate
The end-to-end scenario (create → reserve → attend → finalize → charge/debt → top-up → settle) passes in two places:
- **As an integration test**, through the API, using a signed Stripe webhook for the top-up. Reconciliation finds 0 issues afterwards.
- **Against the real local stack** (18/18 checks): a member registered and verified through Mailpit, reserved, was marked present, and was charged €10 (€6 paid, €4 debt). A €25 cash top-up settled the debt first, a correction reversed the charge, and reconciliation of the dev database found 0 issues. The top-up was recorded as cash because stripe-mock allows only one top-up per database (see ADR 0004).
