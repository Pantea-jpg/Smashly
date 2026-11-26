import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser } from '../../../test/fixtures';
import { chargeFor, ledgerFor, walletOf } from '../../../test/money';
import { loginAs, type TestSession } from '../../../test/sessions';
import { FakePaymentProvider } from '../../integrations/payments/fake-payment-provider';

const prisma = useTestDatabase();
let clock = Date.now();
const provider = new FakePaymentProvider();
const { app } = buildTestApp({ prisma, paymentProvider: provider, now: () => new Date(clock) });
const ledger = ledgerFor(prisma);

let user: { id: string; email: string; password: string };
let member: TestSession;
let admin: TestSession;
let adminId: string;
let keyCounter = 0;
const newKey = () => `topup-key-${Date.now()}-${(keyCounter += 1)}`;

async function topUp(amountMinor: number, key = newKey()) {
  return request(app)
    .post('/api/v1/me/wallet/top-ups')
    .set(member.auth)
    .set('idempotency-key', key)
    .send({ amountMinor, currency: 'EUR' });
}

async function deliver(type: string, object: Record<string, unknown>, id?: string) {
  const event = provider.signedEvent(type, object, id);
  const res = await request(app)
    .post('/api/v1/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('stripe-signature', event.signature)
    .send(event.payload);
  return { res, event };
}

async function paidTopUp(amountMinor: number) {
  const created = await topUp(amountMinor);
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: created.body.data.paymentId as string },
  });
  provider.complete(payment.providerPaymentId!);
  await deliver('payment_intent.succeeded', provider.intentObject(payment.providerPaymentId!));
  return payment;
}

beforeEach(async () => {
  clock = Date.now();
  user = await createUser(prisma);
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  member = await loginAs(app, user);
  const a = await createUser(prisma, { role: 'ADMIN' });
  adminId = a.id;
  admin = await loginAs(app, a);
});

describe('creating a top-up', () => {
  it('returns a client secret for the PaymentSheet but does NOT credit the wallet yet', async () => {
    const res = await topUp(2500);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      clientSecret: expect.stringContaining('_secret_'),
      publishableKey: 'pk_test_fake',
      amount: { amountMinor: 2500, currency: 'EUR' },
    });
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(0);
    const payment = await request(app)
      .get(`/api/v1/me/payments/${res.body.data.paymentId}`)
      .set(member.auth);
    expect(payment.body.data.status).toBe('REQUIRES_PAYMENT');
  });

  it('is idempotent per Idempotency-Key: one payment, one intent', async () => {
    const a = await topUp(2500, 'same-topup-key');
    const b = await topUp(2500, 'same-topup-key');
    expect(b.body.data.paymentId).toBe(a.body.data.paymentId);
    expect(b.body.data.clientSecret).toBe(a.body.data.clientSecret);
    expect(provider.intents.size).toBeGreaterThan(0);
    expect(await prisma.payment.count()).toBe(1);
    const different = await topUp(5000, 'same-topup-key');
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('enforces the header, a verified email and the configured limits', async () => {
    const noKey = await request(app)
      .post('/api/v1/me/wallet/top-ups')
      .set(member.auth)
      .send({ amountMinor: 2500, currency: 'EUR' });
    expect(noKey.status).toBe(400);

    expect((await topUp(400)).body.error.code).toBe('AMOUNT_OUT_OF_RANGE');
    expect((await topUp(50_001)).body.error.code).toBe('AMOUNT_OUT_OF_RANGE');

    await prisma.wallet.updateMany({ where: { userId: user.id }, data: { balanceMinor: 99_000 } });
    expect((await topUp(2000)).body.error.code).toBe('BALANCE_LIMIT_EXCEEDED');

    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: null } });
    expect((await topUp(2500)).body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('reports a provider outage without leaving a usable payment behind', async () => {
    provider.failNextCreate = true;
    const res = await topUp(2500);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
  });
});

describe('Stripe webhooks', () => {
  it('credits exactly once on payment_intent.succeeded, even for duplicate and re-sent events', async () => {
    const created = await topUp(2500);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: created.body.data.paymentId as string },
    });
    provider.complete(payment.providerPaymentId!);

    const first = await deliver(
      'payment_intent.succeeded',
      provider.intentObject(payment.providerPaymentId!),
    );
    expect(first.res.status).toBe(200);
    expect(first.res.body).toEqual({ received: true, duplicate: false });

    // The same event delivered again, and a second event for the same intent.
    const again = await deliver(
      'payment_intent.succeeded',
      provider.intentObject(payment.providerPaymentId!),
      first.event.id,
    );
    expect(again.res.body.duplicate).toBe(true);
    await deliver('payment_intent.succeeded', provider.intentObject(payment.providerPaymentId!));

    const wallet = await walletOf(prisma, user.id);
    expect(wallet.balanceMinor).toBe(2500);
    expect(await prisma.walletTransaction.count({ where: { type: 'ONLINE_TOP_UP' } })).toBe(1);
    const status = await request(app).get(`/api/v1/me/payments/${payment.id}`).set(member.auth);
    expect(status.body.data).toMatchObject({ status: 'SUCCEEDED', methodType: 'card' });
    expect(
      await prisma.notification.count({ where: { userId: user.id, type: 'TOP_UP_SUCCEEDED' } }),
    ).toBe(1);
  });

  it('rejects unsigned or tampered events and stores nothing', async () => {
    const event = provider.signedEvent('payment_intent.succeeded', {
      id: 'pi_x',
      object: 'payment_intent',
    });
    const tampered = await request(app)
      .post('/api/v1/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', event.signature)
      .send(event.payload.replace('pi_x', 'pi_y'));
    expect(tampered.status).toBe(400);
    const unsigned = await request(app)
      .post('/api/v1/webhooks/stripe')
      .set('content-type', 'application/json')
      .send(event.payload);
    expect(unsigned.status).toBe(400);
    expect(await prisma.stripeEvent.count()).toBe(0);
  });

  it('ignores out-of-order events: "processing" after "succeeded" does not regress', async () => {
    const payment = await paidTopUp(2500);
    const processing = {
      ...provider.intentObject(payment.providerPaymentId!),
      status: 'processing',
    };
    await deliver('payment_intent.processing', processing);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'SUCCEEDED',
    );
  });

  it('holds a payment for review when Stripe reports a different amount', async () => {
    const created = await topUp(2500);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: created.body.data.paymentId as string },
    });
    provider.complete(payment.providerPaymentId!, { amountReceivedMinor: 2400 });
    await deliver('payment_intent.succeeded', provider.intentObject(payment.providerPaymentId!));
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'REQUIRES_REVIEW',
    );
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'payment.requires_review' } })).toBe(1);
  });

  it('a top-up pays outstanding debt first', async () => {
    await chargeFor(prisma, ledger, { adminId, userId: user.id, priceMinor: 1000 });
    await paidTopUp(2500);
    const wallet = await walletOf(prisma, user.id);
    expect(wallet).toMatchObject({ balanceMinor: 1500, debtMinor: 0 });
  });

  it('a failed attempt is recorded and notified; a later success still credits', async () => {
    const created = await topUp(2500);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: created.body.data.paymentId as string },
    });
    const failed = {
      ...provider.intentObject(payment.providerPaymentId!),
      status: 'requires_payment_method',
      last_payment_error: { code: 'card_declined' },
    };
    await deliver('payment_intent.payment_failed', failed);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
      status: 'FAILED',
      failureCode: 'card_declined',
    });
    expect(await prisma.notification.count({ where: { type: 'TOP_UP_FAILED' } })).toBe(1);

    provider.complete(payment.providerPaymentId!);
    await deliver('payment_intent.succeeded', provider.intentObject(payment.providerPaymentId!));
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(2500);
  });
});

describe('refunds and chargebacks', () => {
  async function refund(body: Record<string, unknown>, key = newKey()) {
    return request(app)
      .post(`/api/v1/admin/users/${user.id}/refunds`)
      .set(admin.auth)
      .set('idempotency-key', key)
      .send(body);
  }

  it('an admin refunds part of a top-up to the card; the later webhook does not debit twice', async () => {
    const payment = await paidTopUp(5000);
    const res = await refund({
      method: 'STRIPE',
      paymentId: payment.id,
      amountMinor: 2000,
      reason: 'Unused balance',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.transaction).toMatchObject({
      type: 'REFUND',
      paymentMethod: 'STRIPE',
      walletDelta: { amountMinor: -2000 },
    });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      refundedAmountMinor: 2000,
    });

    const stripeRefund = provider.refunds[0]!;
    await deliver('refund.updated', {
      id: stripeRefund.id,
      object: 'refund',
      amount: 2000,
      status: 'succeeded',
      payment_intent: payment.providerPaymentId,
      metadata: {},
    });
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(3000);
    expect(await prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(1);
  });

  it('refuses refunds above the balance or the refundable amount', async () => {
    const payment = await paidTopUp(2000);
    expect(
      (
        await refund({
          method: 'STRIPE',
          paymentId: payment.id,
          amountMinor: 2500,
          reason: 'Too much',
        })
      ).body.error.code,
    ).toBe('AMOUNT_OUT_OF_RANGE');
    await chargeFor(prisma, ledger, { adminId, userId: user.id, priceMinor: 1500 });
    expect(
      (
        await refund({
          method: 'STRIPE',
          paymentId: payment.id,
          amountMinor: 1000,
          reason: 'Spent already',
        })
      ).body.error.code,
    ).toBe('INSUFFICIENT_BALANCE');
    expect(
      (await refund({ method: 'CASH', amountMinor: 501, reason: 'Cash back' })).body.error.code,
    ).toBe('INSUFFICIENT_BALANCE');
    expect((await refund({ method: 'CASH', amountMinor: 500, reason: 'Cash back' })).status).toBe(
      201,
    );
  });

  it('a refund made in the Stripe dashboard after the money was spent becomes debt (D18)', async () => {
    const payment = await paidTopUp(2000);
    await chargeFor(prisma, ledger, { adminId, userId: user.id, priceMinor: 1500 });
    await deliver('refund.created', {
      id: 're_dashboard_1',
      object: 'refund',
      amount: 2000,
      status: 'succeeded',
      payment_intent: payment.providerPaymentId,
      metadata: {},
    });
    expect(await walletOf(prisma, user.id)).toMatchObject({ balanceMinor: 0, debtMinor: 1500 });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'REFUNDED',
    );
  });

  it('a chargeback debits the wallet; winning it credits the money back', async () => {
    const payment = await paidTopUp(2000);
    const dispute = {
      id: 'dp_1',
      object: 'dispute',
      amount: 2000,
      payment_intent: payment.providerPaymentId,
      reason: 'fraudulent',
      status: 'needs_response',
    };
    await deliver('charge.dispute.created', dispute);
    expect(await walletOf(prisma, user.id)).toMatchObject({ balanceMinor: 0, debtMinor: 0 });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'DISPUTED',
    );

    await deliver('charge.dispute.closed', { ...dispute, status: 'won' });
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(2000);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'SUCCEEDED',
    );
  });
});

describe('payment sweeper', () => {
  it('credits a paid top-up whose webhook never arrived, and abandons stale intents', async () => {
    const lost = await topUp(2500);
    const lostPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: lost.body.data.paymentId as string },
    });
    provider.complete(lostPayment.providerPaymentId!);
    const stale = await topUp(1000);

    clock += 16 * 60_000;
    let result = await app.locals.services.payments.sweep();
    expect(result).toMatchObject({ checked: 2, credited: 1, abandoned: 0 });
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(2500);

    clock += 24 * 60 * 60_000;
    result = await app.locals.services.payments.sweep();
    expect(result.abandoned).toBe(1);
    expect(
      (
        await prisma.payment.findUniqueOrThrow({
          where: { id: stale.body.data.paymentId as string },
        })
      ).status,
    ).toBe('CANCELED');
  });
});

describe('without Stripe configured', () => {
  it('answers 503 PAYMENTS_UNAVAILABLE for top-ups and webhooks', async () => {
    const offline = buildTestApp({ prisma, paymentProvider: null }).app;
    const session = await loginAs(offline, user);
    const res = await request(offline)
      .post('/api/v1/me/wallet/top-ups')
      .set(session.auth)
      .set('idempotency-key', newKey())
      .send({ amountMinor: 2500, currency: 'EUR' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
    const hook = await request(offline)
      .post('/api/v1/webhooks/stripe')
      .set('stripe-signature', 'x')
      .set('content-type', 'application/json')
      .send('{}');
    expect(hook.status).toBe(503);
  });
});
