import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser } from '../../../test/fixtures';
import { adminContext, ledgerFor, walletOf } from '../../../test/money';
import { loginAs, type TestSession } from '../../../test/sessions';
import { createTrainingViaApi, HOUR, key, member, testClock } from '../../../test/trainings';
import { FakePaymentProvider } from '../../integrations/payments/fake-payment-provider';
import { ReconciliationService } from '../reports/reconciliation.service';
import { AttendanceService } from './attendance.service';
import { TrainingsService } from './trainings.service';
import { SettingsService } from '../admin/settings.service';

const prisma = useTestDatabase();
const clock = testClock();
const provider = new FakePaymentProvider();
const { app } = buildTestApp({ prisma, now: clock.now, paymentProvider: provider });
const ledger = ledgerFor(prisma);

let admin: TestSession;
let adminId: string;

beforeEach(async () => {
  clock.set(Date.now());
  const a = await createUser(prisma, { role: 'ADMIN' });
  adminId = a.id;
  admin = await loginAs(app, a);
});

/** A training that started an hour ago (attendance can be recorded). */
const pastTraining = (extra: Record<string, unknown> = {}) =>
  createTrainingViaApi(app, admin, { clockMs: clock.ms, startsInMs: -HOUR, ...extra });

const mark = (trainingId: string, entries: { userId: string; status: string; note?: string }[]) =>
  request(app)
    .put(`/api/v1/admin/trainings/${trainingId}/attendance`)
    .set(admin.auth)
    .send({ entries });

const finalize = (trainingId: string, body: Record<string, unknown> = {}, headers = key()) =>
  request(app)
    .post(`/api/v1/admin/trainings/${trainingId}/attendance/finalize`)
    .set(admin.auth)
    .set(headers)
    .send(body);

const correct = (
  trainingId: string,
  userId: string,
  status: string,
  reason = 'Checked the sign-in sheet',
) =>
  request(app)
    .post(`/api/v1/admin/trainings/${trainingId}/attendance/${userId}/correction`)
    .set(admin.auth)
    .set(key())
    .send({ status, reason });

const cash = (userId: string, amountMinor: number) =>
  ledger.creditCash(
    { userId, amountMinor, adminId, idempotencyKey: randomUUID() },
    adminContext(adminId),
  );

const reconcile = async () => (await new ReconciliationService(prisma).run()).issues;

describe('marking attendance', () => {
  it('waits for the start, adds walk-ins and lists reserved members as pending', async () => {
    const [reserved, walkIn] = [await member(prisma, app), await member(prisma, app)];
    const future = await createTrainingViaApi(app, admin, {
      clockMs: clock.ms,
      startsInMs: 10 * 60_000,
    });
    await request(app)
      .put(`/api/v1/me/trainings/${future.id}/reservation`)
      .set(reserved.session.auth)
      .send({ status: 'ATTENDING' })
      .expect(200);
    expect(
      (await mark(future.id, [{ userId: reserved.id, status: 'PRESENT' }])).body.error.code,
    ).toBe('TRAINING_NOT_STARTED');

    clock.advance(11 * 60_000);
    const before = await request(app)
      .get(`/api/v1/admin/trainings/${future.id}/attendance`)
      .set(admin.auth);
    expect(before.body.data).toEqual([
      expect.objectContaining({ status: 'PENDING', reservation: 'ATTENDING', charge: null }),
    ]);

    const marked = await mark(future.id, [
      { userId: walkIn.id, status: 'PRESENT', note: 'walk-in' },
    ]);
    expect(marked.status).toBe(200);
    expect(marked.body.data).toHaveLength(2);
    expect(
      marked.body.data.find((r: { user: { id: string } }) => r.user.id === walkIn.id),
    ).toMatchObject({ status: 'PRESENT', reservation: null, note: 'walk-in' });
    expect((await mark(future.id, [{ userId: adminId, status: 'PRESENT' }])).status).toBe(400);
  });
});

describe('finalization', () => {
  it('charges PRESENT members only, at their own price, with debt for shortfalls', async () => {
    const [rich, poor, absent, excused, free] = [
      await member(prisma, app),
      await member(prisma, app),
      await member(prisma, app),
      await member(prisma, app),
      await member(prisma, app),
    ];
    const t = await pastTraining({ defaultPriceMinor: 1000 });
    await cash(rich.id, 5000);
    await cash(poor.id, 600);
    await request(app)
      .put(`/api/v1/admin/trainings/${t.id}/price-overrides/${free.id}`)
      .set(admin.auth)
      .send({ priceMinor: 0 })
      .expect(204);
    await mark(t.id, [
      { userId: rich.id, status: 'PRESENT' },
      { userId: poor.id, status: 'PRESENT' },
      { userId: absent.id, status: 'ABSENT' },
      { userId: excused.id, status: 'EXCUSED' },
      { userId: free.id, status: 'PRESENT' },
    ]).expect(200);

    const res = await finalize(t.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      charged: 3,
      totalCharged: { amountMinor: 2000 },
      paidFromWallets: { amountMinor: 1600 },
      debtCreated: { amountMinor: 400 },
      training: { status: 'COMPLETED', counts: { present: 3, absent: 1, excused: 1, pending: 0 } },
    });
    expect(res.body.data.training.finalizedAt).not.toBeNull();
    // The spec's €10 / €6 example: €6 paid from the wallet, €4 debt.
    expect(await walletOf(prisma, poor.id)).toMatchObject({ balanceMinor: 0, debtMinor: 400 });
    expect(await walletOf(prisma, rich.id)).toMatchObject({ balanceMinor: 4000, debtMinor: 0 });
    expect(await walletOf(prisma, absent.id)).toMatchObject({ balanceMinor: 0, debtMinor: 0 });
    expect(
      await prisma.trainingCharge.count({ where: { userId: { in: [absent.id, excused.id] } } }),
    ).toBe(0);
    const freeCharge = await prisma.trainingCharge.findFirstOrThrow({ where: { userId: free.id } });
    expect(freeCharge).toMatchObject({ unitPriceMinor: 0, priceSource: 'TRAINING_OVERRIDE' });
    expect(await reconcile()).toEqual([]);
  });

  it('refuses while anyone is pending unless pendingAs ABSENT is given', async () => {
    const [m, n] = [await member(prisma, app), await member(prisma, app)];
    const t = await createTrainingViaApi(app, admin, { clockMs: clock.ms, startsInMs: 5 * 60_000 });
    await request(app)
      .put(`/api/v1/me/trainings/${t.id}/reservation`)
      .set(m.session.auth)
      .send({ status: 'ATTENDING' })
      .expect(200);
    clock.advance(6 * 60_000);
    await mark(t.id, [{ userId: n.id, status: 'PRESENT' }]).expect(200);

    const refused = await finalize(t.id);
    expect(refused.body.error).toMatchObject({
      code: 'ATTENDANCE_HAS_PENDING',
      details: { pending: 1 },
    });
    expect(await prisma.trainingCharge.count()).toBe(0);

    const ok = await finalize(t.id, { pendingAs: 'ABSENT' });
    expect(ok.body.data).toMatchObject({
      charged: 1,
      training: { counts: { present: 1, absent: 1, pending: 0 } },
    });
  });

  it('snapshots the price: later price changes never touch the charge (D6)', async () => {
    const m = await member(prisma, app);
    const t = await pastTraining({ defaultPriceMinor: 1000 });
    await mark(t.id, [{ userId: m.id, status: 'PRESENT' }]).expect(200);
    await finalize(t.id).expect(200);
    await request(app)
      .put(`/api/v1/admin/trainings/${t.id}/price-overrides/${m.id}`)
      .set(admin.auth)
      .send({ priceMinor: 300 })
      .expect(204);
    await request(app)
      .put(`/api/v1/admin/users/${m.id}/standing-price`)
      .set(admin.auth)
      .send({ priceMinor: 200 })
      .expect(200);
    expect(
      (
        await request(app)
          .patch(`/api/v1/admin/trainings/${t.id}`)
          .set(admin.auth)
          .send({ defaultPriceMinor: 5 })
      ).body.error.code,
    ).toBe('ATTENDANCE_FINALIZED');
    expect(await prisma.trainingCharge.findFirstOrThrow({ where: { userId: m.id } })).toMatchObject(
      { unitPriceMinor: 1000, priceSource: 'TRAINING_DEFAULT' },
    );
    expect(await walletOf(prisma, m.id)).toMatchObject({ debtMinor: 1000 });
  });

  it('charges once: a replayed key returns the same result, a second finalize is refused', async () => {
    const m = await member(prisma, app);
    const t = await pastTraining();
    await mark(t.id, [{ userId: m.id, status: 'PRESENT' }]).expect(200);
    const sameKey = key();
    const first = await finalize(t.id, {}, sameKey);
    const replay = await finalize(t.id, {}, sameKey);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect((await finalize(t.id)).body.error.code).toBe('ATTENDANCE_FINALIZED');
    expect(await prisma.trainingCharge.count()).toBe(1);
  });

  it('survives concurrent finalize requests with different keys (row lock)', async () => {
    const members = await Promise.all(Array.from({ length: 4 }, () => member(prisma, app)));
    const t = await pastTraining();
    await mark(
      t.id,
      members.map((m) => ({ userId: m.id, status: 'PRESENT' })),
    ).expect(200);
    const results = await Promise.all(Array.from({ length: 5 }, () => finalize(t.id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.body.error?.code === 'ATTENDANCE_FINALIZED')).toHaveLength(4);
    expect(await prisma.trainingCharge.count()).toBe(4);
    expect((await mark(t.id, [{ userId: members[0]!.id, status: 'ABSENT' }])).body.error.code).toBe(
      'ATTENDANCE_FINALIZED',
    );
    expect(await reconcile()).toEqual([]);
  });

  it('shows unfinalized trainings in the queue and reminds admins once after 24 h (D13)', async () => {
    const t = await createTrainingViaApi(app, admin, { clockMs: clock.ms, startsInMs: -26 * HOUR });
    const recent = await pastTraining();
    const queue = await request(app).get('/api/v1/admin/attendance/queue').set(admin.auth);
    expect(queue.body.data.map((q: { training: { id: string } }) => q.training.id)).toEqual([t.id]); // `recent` has not ended yet
    expect(queue.body.data[0].hoursSinceEnd).toBe(25);

    const service = new AttendanceService(
      prisma,
      ledger,
      new TrainingsService(prisma, ledger, new SettingsService(prisma), clock.now),
      clock.now,
    );
    expect(await service.remindUnfinalized()).toBe(1);
    await service.remindUnfinalized();
    expect(
      await prisma.notification.count({
        where: { userId: adminId, type: 'ATTENDANCE_FINALIZATION_REMINDER' },
      }),
    ).toBe(1);
    expect(recent.status).toBe('SCHEDULED');
  });
});

describe('corrections after finalization (D11)', () => {
  it('reverses a charge (PRESENT → ABSENT) and charges a missed member (ABSENT → PRESENT)', async () => {
    const [wrong, missed] = [await member(prisma, app), await member(prisma, app)];
    await cash(wrong.id, 2500);
    const t = await pastTraining({ defaultPriceMinor: 1000 });
    await mark(t.id, [
      { userId: wrong.id, status: 'PRESENT' },
      { userId: missed.id, status: 'ABSENT' },
    ]).expect(200);
    await finalize(t.id).expect(200);
    expect(await walletOf(prisma, wrong.id)).toMatchObject({ balanceMinor: 1500 });

    const undo = await correct(t.id, wrong.id, 'ABSENT');
    expect(undo.status).toBe(200);
    expect(undo.body.data).toMatchObject({
      attendance: { status: 'ABSENT', charge: { status: 'REVERSED' } },
      charge: null,
    });
    expect(undo.body.data.reversal.transaction).toMatchObject({
      type: 'REVERSAL',
      walletDelta: { amountMinor: 1000 },
    });
    expect(await walletOf(prisma, wrong.id)).toMatchObject({ balanceMinor: 2500 });

    const add = await correct(t.id, missed.id, 'PRESENT');
    expect(add.body.data).toMatchObject({
      reversal: null,
      attendance: {
        status: 'PRESENT',
        charge: { status: 'ACTIVE', unitPrice: { amountMinor: 1000 } },
      },
    });
    expect(await walletOf(prisma, missed.id)).toMatchObject({ balanceMinor: 0, debtMinor: 1000 });

    // A correction to the same state changes nothing; the reason is required.
    const noop = await correct(t.id, missed.id, 'PRESENT');
    expect(noop.body.data).toMatchObject({ reversal: null, charge: null });
    expect((await correct(t.id, missed.id, 'ABSENT', '')).status).toBe(400);
    expect(await prisma.auditLog.count({ where: { action: 'attendance.corrected' } })).toBe(3);
    expect(await reconcile()).toEqual([]);
  });

  it('is only for finalized trainings', async () => {
    const m = await member(prisma, app);
    const t = await pastTraining();
    expect((await correct(t.id, m.id, 'PRESENT')).body.error.code).toBe('CONFLICT');
  });
});

describe('cancelling a finalized training (D12)', () => {
  it('reverses every charge: paid money returns, open debt is cancelled', async () => {
    const [payer, debtor] = [await member(prisma, app), await member(prisma, app)];
    await cash(payer.id, 1000);
    await cash(debtor.id, 300);
    const t = await pastTraining({ defaultPriceMinor: 1000 });
    await mark(t.id, [
      { userId: payer.id, status: 'PRESENT' },
      { userId: debtor.id, status: 'PRESENT' },
    ]).expect(200);
    await finalize(t.id).expect(200);
    expect(await walletOf(prisma, debtor.id)).toMatchObject({ balanceMinor: 0, debtMinor: 700 });

    const res = await request(app)
      .post(`/api/v1/admin/trainings/${t.id}/cancel`)
      .set(admin.auth)
      .send({ reason: 'Coach was ill; nobody should pay' });
    expect(res.body.data).toMatchObject({ reversedCharges: 2, training: { status: 'CANCELLED' } });
    expect(await walletOf(prisma, payer.id)).toMatchObject({ balanceMinor: 1000, debtMinor: 0 });
    expect(await walletOf(prisma, debtor.id)).toMatchObject({ balanceMinor: 300, debtMinor: 0 });
    expect(await prisma.trainingCharge.count({ where: { status: 'ACTIVE' } })).toBe(0);
    expect(
      await prisma.notification.count({
        where: { type: 'TRAINING_CANCELLED', params: { path: ['refunded'], equals: true } },
      }),
    ).toBe(2);
    expect(await reconcile()).toEqual([]);
  });
});

describe('Phase 6 gate: create → reserve → attend → finalize → charge/debt → top-up → settle', () => {
  it('runs the whole flow through the API', async () => {
    const m = await member(prisma, app);
    await prisma.user.update({ where: { id: m.id }, data: { emailVerifiedAt: new Date() } });
    await cash(m.id, 600);

    // 1. Admin creates a training starting in 10 minutes; the member reserves.
    const t = await createTrainingViaApi(app, admin, {
      clockMs: clock.ms,
      startsInMs: 10 * 60_000,
      capacity: 10,
      defaultPriceMinor: 1000,
    });
    const reserved = await request(app)
      .put(`/api/v1/me/trainings/${t.id}/reservation`)
      .set(m.session.auth)
      .send({ status: 'ATTENDING' });
    expect(reserved.body.data).toMatchObject({
      warning: null,
      training: {
        myReservation: 'ATTENDING',
        spotsLeft: 9,
        myPrice: { price: { amountMinor: 1000 } },
      },
    });

    // 2. The training happens; the admin marks attendance and finalizes.
    clock.advance(12 * 60_000);
    await mark(t.id, [{ userId: m.id, status: 'PRESENT' }]).expect(200);
    await finalize(t.id).expect(200);

    // 3. €6 was paid from the wallet; €4 became debt.
    const charged = await request(app).get(`/api/v1/me/trainings/${t.id}`).set(m.session.auth);
    expect(charged.body.data).toMatchObject({
      myAttendance: 'PRESENT',
      myCharge: {
        status: 'ACTIVE',
        paidFromWallet: { amountMinor: 600 },
        shortfall: { amountMinor: 400 },
      },
    });
    expect(
      (await request(app).get('/api/v1/me/wallet').set(m.session.auth)).body.data,
    ).toMatchObject({ balance: { amountMinor: 0 }, debt: { amountMinor: 400 } });
    expect(
      await prisma.notification.count({ where: { userId: m.id, type: 'TRAINING_CHARGED' } }),
    ).toBe(1);

    // 4. The member tops up €25 online; the verified webhook credits the wallet.
    const topUp = await request(app)
      .post('/api/v1/me/wallet/top-ups')
      .set(m.session.auth)
      .set(key())
      .send({ amountMinor: 2500, currency: 'EUR' });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: topUp.body.data.paymentId as string },
    });
    provider.complete(payment.providerPaymentId!);
    const event = provider.signedEvent(
      'payment_intent.succeeded',
      provider.intentObject(payment.providerPaymentId!),
    );
    await request(app)
      .post('/api/v1/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', event.signature)
      .send(event.payload)
      .expect(200);

    // 5. The debt was settled first (FIFO): €25 − €4 = €21 left.
    expect(
      (await request(app).get('/api/v1/me/wallet').set(m.session.auth)).body.data,
    ).toMatchObject({ balance: { amountMinor: 2100 }, debt: { amountMinor: 0 } });
    const debts = await request(app).get('/api/v1/me/debts').set(m.session.auth);
    expect(debts.body.data).toEqual([
      expect.objectContaining({
        status: 'SETTLED',
        outstandingAmount: { amountMinor: 0, currency: 'EUR' },
      }),
    ]);
    const history = await request(app).get('/api/v1/me/attendance').set(m.session.auth);
    expect(history.body.data).toEqual([
      expect.objectContaining({
        attendance: 'PRESENT',
        charge: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    ]);
    const adminHistory = await request(app)
      .get(`/api/v1/admin/users/${m.id}/trainings`)
      .set(admin.auth);
    expect(adminHistory.body.data).toHaveLength(1);
    expect(await reconcile()).toEqual([]);
  });
});
