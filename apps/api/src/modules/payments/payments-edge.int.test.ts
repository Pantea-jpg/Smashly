/**
 * Phase 9 financial edge-case suite: what Stripe and admins can do in unusual orders, twice,
 * or at the same time. Every test ends by checking the money (wallet totals, ledger rows,
 * payment refund bookkeeping), not just status codes.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser } from '../../../test/fixtures';
import { adminContext, walletOf } from '../../../test/money';
import { loginAs, type TestSession } from '../../../test/sessions';
import { alerts } from '../../core/observability/alerts';
import { FakePaymentProvider } from '../../integrations/payments/fake-payment-provider';

const prisma = useTestDatabase();
let clock = Date.now();
const provider = new FakePaymentProvider();
const { app } = buildTestApp({ prisma, paymentProvider: provider, now: () => new Date(clock) });
const { ledger, payments, reconciliation } = app.locals.services;

let user: { id: string; email: string; password: string };
let member: TestSession;
let admin: TestSession;
let adminId: string;
let keyCounter = 0;
const newKey = () => `edge-key-${Date.now()}-${(keyCounter += 1)}`;

async function deliver(type: string, object: Record<string, unknown>, id?: string) {
  const event = provider.signedEvent(type, object, id);
  return request(app)
    .post('/api/v1/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('stripe-signature', event.signature)
    .send(event.payload);
}

async function paidTopUp(amountMinor: number) {
  const created = await request(app)
    .post('/api/v1/me/wallet/top-ups')
    .set(member.auth)
    .set('idempotency-key', newKey())
    .send({ amountMinor, currency: 'EUR' });
  expect(created.status).toBe(201);
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: created.body.data.paymentId as string },
  });
  provider.complete(payment.providerPaymentId!);
  const res = await deliver(
    'payment_intent.succeeded',
    provider.intentObject(payment.providerPaymentId!),
  );
  expect(res.status).toBe(200);
  return payment;
}

async function adminRefund(paymentId: string, amountMinor: number) {
  return request(app)
    .post(`/api/v1/admin/users/${user.id}/refunds`)
    .set(admin.auth)
    .set('idempotency-key', newKey())
    .send({ method: 'STRIPE', paymentId, amountMinor, reason: 'Unused balance' });
}

const refundObject = (
  id: string,
  paymentIntent: string | null,
  amount: number,
  status: string,
): Record<string, unknown> => ({
  id,
  object: 'refund',
  amount,
  status,
  payment_intent: paymentIntent,
  metadata: {},
});

const paymentRow = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });

/** Cached totals must equal the sum of ledger rows: the invariant every test ends on. */
async function expectLedgerConsistent() {
  const report = await reconciliation.run();
  expect(report.issues).toEqual([]);
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

describe('failed card refunds', () => {
  it('returns the money once when Stripe reports the failure twice (refund.failed + refund.updated)', async () => {
    const payment = await paidTopUp(5000);
    expect((await adminRefund(payment.id, 2000)).status).toBe(201);
    expect((await adminRefund(payment.id, 1000)).status).toBe(201);
    expect(await paymentRow(payment.id)).toMatchObject({
      refundedAmountMinor: 3000,
      status: 'PARTIALLY_REFUNDED',
    });
    const [first] = provider.refunds.slice(-2);
    const failed = refundObject(first!.id, payment.providerPaymentId, 2000, 'failed');

    expect((await deliver('refund.failed', failed)).status).toBe(200);
    expect((await deliver('refund.updated', failed)).status).toBe(200);

    // 5000 - 2000 - 1000 + 2000 returned once.
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(4000);
    // Before the fix the second report reduced refundedAmountMinor again (to 0, "SUCCEEDED").
    expect(await paymentRow(payment.id)).toMatchObject({
      refundedAmountMinor: 1000,
      status: 'PARTIALLY_REFUNDED',
    });
    const returned = await prisma.walletTransaction.findMany({
      where: { idempotencyKey: `stripe_refund_failed:${first!.id}` },
    });
    expect(returned).toHaveLength(1);
    expect(returned[0]!.description).toBe('Card refund failed');
    await expectLedgerConsistent();
  });

  it('handles both failure reports arriving at the same time', async () => {
    const payment = await paidTopUp(3000);
    expect((await adminRefund(payment.id, 3000)).status).toBe(201);
    const stripeRefund = provider.refunds.at(-1)!;
    const failed = refundObject(stripeRefund.id, payment.providerPaymentId, 3000, 'failed');

    const results = await Promise.all([
      deliver('refund.failed', failed),
      deliver('refund.updated', failed),
      deliver('refund.updated', failed),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(3000);
    expect(await paymentRow(payment.id)).toMatchObject({
      refundedAmountMinor: 0,
      status: 'SUCCEEDED',
    });
    await expectLedgerConsistent();
  });

  it('never debits a dashboard refund whose "failed" event arrived before its "pending" event', async () => {
    const payment = await paidTopUp(2000);
    const id = `re_dash_${randomUUID().slice(0, 8)}`;
    await deliver('refund.failed', refundObject(id, payment.providerPaymentId, 2000, 'failed'));
    // Stripe retries the earlier event later: before the fix this debited the wallet.
    await deliver('refund.created', refundObject(id, payment.providerPaymentId, 2000, 'pending'));

    expect(await walletOf(prisma, user.id)).toMatchObject({ balanceMinor: 2000, debtMinor: 0 });
    expect(await paymentRow(payment.id)).toMatchObject({
      refundedAmountMinor: 0,
      status: 'SUCCEEDED',
    });
    expect(await prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(0);
    await expectLedgerConsistent();
  });

  it('pending then failed: debits, then gives the money back', async () => {
    const payment = await paidTopUp(2500);
    const id = `re_dash_${randomUUID().slice(0, 8)}`;
    await deliver('refund.created', refundObject(id, payment.providerPaymentId, 1000, 'pending'));
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(1500);
    await deliver('refund.updated', refundObject(id, payment.providerPaymentId, 1000, 'canceled'));
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(2500);
    expect((await paymentRow(payment.id)).status).toBe('SUCCEEDED');
    await expectLedgerConsistent();
  });

  it('refuses to book a refund that Stripe reports as failed straight away', async () => {
    const payment = await paidTopUp(2000);
    vi.spyOn(provider, 'createRefund').mockResolvedValueOnce({
      id: 're_instant_fail',
      status: 'failed',
      amountMinor: 2000,
      paymentIntentId: payment.providerPaymentId,
    });
    const res = await adminRefund(payment.id, 2000);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(2000);
  });

  it('leaves the wallet untouched when Stripe cannot create the refund', async () => {
    const payment = await paidTopUp(2000);
    vi.spyOn(provider, 'createRefund').mockRejectedValueOnce(new Error('card_declined'));
    const res = await adminRefund(payment.id, 500);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(2000);
    expect((await paymentRow(payment.id)).refundedAmountMinor).toBe(0);
  });

  it('only refunds this member’s own online payments', async () => {
    const other = await createUser(prisma);
    const res = await request(app)
      .post(`/api/v1/admin/users/${other.id}/refunds`)
      .set(admin.auth)
      .set('idempotency-key', newKey())
      .send({
        method: 'STRIPE',
        paymentId: (await paidTopUp(1000)).id,
        amountMinor: 500,
        reason: 'Wrong person',
      });
    expect(res.status).toBe(404);
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(1000);
  });
});

describe('chargebacks', () => {
  const disputeFor = (pi: string | null, amount: number, status: string) => ({
    id: 'dp_edge',
    object: 'dispute',
    amount,
    payment_intent: pi,
    reason: 'fraudulent',
    status,
  });

  it('credits a won dispute once even when "closed" is delivered as two events', async () => {
    const payment = await paidTopUp(2000);
    await deliver('charge.dispute.created', disputeFor(payment.providerPaymentId, 2000, 'open'));
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(0);
    await deliver('charge.dispute.closed', disputeFor(payment.providerPaymentId, 2000, 'won'));
    await deliver('charge.dispute.closed', disputeFor(payment.providerPaymentId, 2000, 'won'));
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(2000);
    expect((await paymentRow(payment.id)).status).toBe('SUCCEEDED');
    await expectLedgerConsistent();
  });

  it('a lost dispute after the money was spent leaves debt and no credit', async () => {
    const payment = await paidTopUp(2000);
    await ledger.adjust(
      {
        userId: user.id,
        kind: 'DEBIT',
        amountMinor: 1500,
        reason: 'Spent',
        adminId,
        idempotencyKey: newKey(),
      },
      adminContext(adminId),
    );
    await deliver('charge.dispute.created', disputeFor(payment.providerPaymentId, 2000, 'open'));
    await deliver('charge.dispute.closed', disputeFor(payment.providerPaymentId, 2000, 'lost'));
    expect(await walletOf(prisma, user.id)).toMatchObject({ balanceMinor: 0, debtMinor: 1500 });
    expect((await paymentRow(payment.id)).status).toBe('DISPUTED');
    await expectLedgerConsistent();
  });
});

describe('events we cannot match', () => {
  it('acknowledges events for unknown payments, refunds and disputes without moving money', async () => {
    await paidTopUp(1000);
    const before = await prisma.walletTransaction.count();
    const unknownIntent = {
      ...provider.intentObject((await prisma.payment.findFirstOrThrow()).providerPaymentId!),
      id: 'pi_unknown',
      metadata: {},
    };
    const responses = [
      await deliver('payment_intent.succeeded', unknownIntent),
      await deliver('refund.created', refundObject('re_x', 'pi_unknown', 1000, 'succeeded')),
      await deliver('refund.updated', refundObject('re_y', null, 1000, 'succeeded')),
      await deliver('charge.dispute.created', {
        id: 'dp_x',
        object: 'dispute',
        amount: 1000,
        payment_intent: 'pi_unknown',
        reason: 'general',
        status: 'open',
      }),
      await deliver('charge.dispute.closed', {
        id: 'dp_x',
        object: 'dispute',
        amount: 1000,
        payment_intent: 'pi_unknown',
        reason: 'general',
        status: 'won',
      }),
      await deliver('customer.created', { id: 'cus_1', object: 'customer' }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await prisma.walletTransaction.count()).toBe(before);
    expect(await prisma.stripeEvent.count({ where: { processedAt: null } })).toBe(0);
  });

  it('stores the error of an event that failed and processes it when Stripe retries', async () => {
    const created = await request(app)
      .post('/api/v1/me/wallet/top-ups')
      .set(member.auth)
      .set('idempotency-key', newKey())
      .send({ amountMinor: 1500, currency: 'EUR' });
    const payment = await paymentRow(created.body.data.paymentId as string);
    provider.complete(payment.providerPaymentId!);
    const spy = vi
      .spyOn(ledger, 'creditOnlineTopUp')
      .mockRejectedValueOnce(new Error('database restarted'));

    const event = provider.signedEvent(
      'payment_intent.succeeded',
      provider.intentObject(payment.providerPaymentId!),
    );
    const send = () =>
      request(app)
        .post('/api/v1/webhooks/stripe')
        .set('content-type', 'application/json')
        .set('stripe-signature', event.signature)
        .send(event.payload);

    const critical = vi.spyOn(alerts, 'critical');
    expect((await send()).status).toBe(500); // Stripe retries non-2xx answers
    expect(critical).toHaveBeenCalledWith(
      expect.anything(),
      'stripe_webhook_failed',
      expect.any(String),
      expect.objectContaining({ stripeEventId: event.id, error: 'database restarted' }),
    );
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      processedAt: null,
      error: 'database restarted',
    });
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(0);

    expect((await send()).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      error: null,
    });
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(1500);
  });
});

describe('payment intent states', () => {
  async function openTopUp(amountMinor = 1200) {
    const created = await request(app)
      .post('/api/v1/me/wallet/top-ups')
      .set(member.auth)
      .set('idempotency-key', newKey())
      .send({ amountMinor, currency: 'EUR' });
    return paymentRow(created.body.data.paymentId as string);
  }

  it('records processing (iDEAL) and canceled, ignores 3-D Secure, and credits nothing', async () => {
    const a = await openTopUp();
    const pi = provider.intentObject(a.providerPaymentId!);
    await deliver('payment_intent.processing', { ...pi, status: 'processing' });
    expect((await paymentRow(a.id)).status).toBe('PROCESSING');

    const b = await openTopUp();
    const pib = provider.intentObject(b.providerPaymentId!);
    await deliver('payment_intent.requires_action', { ...pib, status: 'requires_action' });
    expect((await paymentRow(b.id)).status).toBe('REQUIRES_PAYMENT');
    await deliver('payment_intent.canceled', { ...pib, status: 'canceled' });
    expect((await paymentRow(b.id)).status).toBe('CANCELED');
    // A late success after cancellation never credits.
    await deliver('payment_intent.succeeded', {
      ...pib,
      status: 'succeeded',
      amount_received: 1200,
    });
    expect((await paymentRow(b.id)).status).toBe('CANCELED');
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(0);
  });

  it('credits once when Stripe delivers several success events at the same moment', async () => {
    const p = await openTopUp(3000);
    provider.complete(p.providerPaymentId!);
    const pi = provider.intentObject(p.providerPaymentId!);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => deliver('payment_intent.succeeded', pi)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(3000);
    expect(await prisma.walletTransaction.count({ where: { type: 'ONLINE_TOP_UP' } })).toBe(1);
    await expectLedgerConsistent();
  });

  it('holds a success in another currency for review instead of crediting it', async () => {
    const critical = vi.spyOn(alerts, 'critical');
    const p = await openTopUp(2000);
    provider.complete(p.providerPaymentId!, { currency: 'USD' });
    await deliver('payment_intent.succeeded', provider.intentObject(p.providerPaymentId!));
    expect((await paymentRow(p.id)).status).toBe('REQUIRES_REVIEW');
    expect(critical).toHaveBeenCalledWith(
      expect.anything(),
      'payment_requires_review',
      expect.any(String),
      expect.objectContaining({ paymentId: p.id, currency: 'USD' }),
    );
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(0);
  });

  it('the sweeper keeps going when Stripe fails for one payment', async () => {
    const broken = await openTopUp(1000);
    const fine = await openTopUp(2000);
    provider.complete(fine.providerPaymentId!);
    const real = provider.retrieveIntent.bind(provider);
    vi.spyOn(provider, 'retrieveIntent').mockImplementation((id) =>
      id === broken.providerPaymentId ? Promise.reject(new Error('timeout')) : real(id),
    );
    clock += 16 * 60_000;
    const result = await payments.sweep();
    expect(result).toMatchObject({ checked: 2, credited: 1 });
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(2000);
    expect((await paymentRow(broken.id)).status).toBe('REQUIRES_PAYMENT');
  });

  it('admins have no wallet to top up', async () => {
    const res = await request(app)
      .post('/api/v1/me/wallet/top-ups')
      .set(admin.auth)
      .set('idempotency-key', newKey())
      .send({ amountMinor: 1000, currency: 'EUR' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await prisma.payment.count({ where: { userId: adminId } })).toBe(0);
  });
});

describe('ledger idempotency across operations', () => {
  it('replays adjustments and cash refunds, and refuses a key reused for another wallet', async () => {
    const ctx = adminContext(adminId);
    const key = newKey();
    const credit = () =>
      ledger.adjust(
        {
          userId: user.id,
          kind: 'CREDIT',
          amountMinor: 900,
          reason: 'Gift',
          adminId,
          idempotencyKey: key,
        },
        ctx,
      );
    const a = await credit();
    const b = await credit();
    expect(b.transaction.id).toBe(a.transaction.id);

    const refundKey = newKey();
    const refund = () =>
      ledger.refundCash(
        { userId: user.id, amountMinor: 400, reason: 'Back', adminId, idempotencyKey: refundKey },
        ctx,
      );
    expect((await refund()).transaction.id).toBe((await refund()).transaction.id);
    expect((await walletOf(prisma, user.id)).balanceMinor).toBe(500);

    const other = await createUser(prisma);
    await expect(
      ledger.adjust(
        {
          userId: other.id,
          kind: 'CREDIT',
          amountMinor: 900,
          reason: 'Gift',
          adminId,
          idempotencyKey: key,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await walletOf(prisma, other.id)).balanceMinor).toBe(0);
  });

  it('refuses to reverse a transaction that does not exist', async () => {
    await expect(
      ledger.reverse(
        { transactionId: randomUUID(), reason: 'Oops', adminId },
        adminContext(adminId),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
