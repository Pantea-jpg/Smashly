import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser } from '../../../test/fixtures';
import { chargeFor, ledgerFor } from '../../../test/money';
import { loginAs, type TestSession } from '../../../test/sessions';

const prisma = useTestDatabase();
const { app } = buildTestApp({ prisma });
const ledger = ledgerFor(prisma);

let admin: TestSession;
let adminId: string;
let member: TestSession;
let userId: string;
let n = 0;
const key = () => `money-key-${Date.now()}-${(n += 1)}`;

function cash(amountMinor: number, idempotencyKey = key()) {
  return request(app)
    .post(`/api/v1/admin/users/${userId}/cash-payments`)
    .set(admin.auth)
    .set('idempotency-key', idempotencyKey)
    .send({ amountMinor, description: 'Cash at training' });
}

beforeEach(async () => {
  const a = await createUser(prisma, { role: 'ADMIN' });
  adminId = a.id;
  admin = await loginAs(app, a);
  const u = await createUser(prisma);
  userId = u.id;
  member = await loginAs(app, u);
});

describe('POST /admin/users/:id/cash-payments', () => {
  it('requires an Idempotency-Key and replays a retried request', async () => {
    const missing = await request(app)
      .post(`/api/v1/admin/users/${userId}/cash-payments`)
      .set(admin.auth)
      .send({ amountMinor: 5000 });
    expect(missing.status).toBe(400);

    const first = await cash(5000, 'cash-retry-1');
    const retry = await cash(5000, 'cash-retry-1');
    expect(first.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.transaction.id).toBe(first.body.data.transaction.id);
    expect(first.body.data.transaction).toMatchObject({
      type: 'CASH_TOP_UP',
      createdByAdminId: adminId,
      description: 'Cash at training',
    });

    const wallet = await request(app).get('/api/v1/me/wallet').set(member.auth);
    expect(wallet.body.data).toMatchObject({
      balance: { amountMinor: 5000 },
      debt: { amountMinor: 0 },
    });
    expect(
      await prisma.notification.count({ where: { userId, type: 'CASH_PAYMENT_RECORDED' } }),
    ).toBe(1);
  });

  it('rejects zero, negative and fractional amounts', async () => {
    for (const amountMinor of [0, -100, 12.5]) {
      expect((await cash(amountMinor)).status).toBe(400);
    }
  });
});

describe('member wallet endpoints', () => {
  it('shows limits and whether online top-ups are possible', async () => {
    const res = await request(app).get('/api/v1/me/wallet').set(member.auth);
    expect(res.body.data).toMatchObject({
      canTopUp: false, // email not verified yet
      topUpLimits: {
        minMinor: 500,
        maxMinor: 50_000,
        maxBalanceMinor: 100_000,
        presetsMinor: [1000, 2500, 5000, 10_000],
      },
    });
  });

  it('pages the ledger newest first and hides who recorded entries', async () => {
    for (let i = 1; i <= 5; i += 1) await cash(i * 100);
    const page1 = await request(app).get('/api/v1/me/transactions?limit=2').set(member.auth);
    expect(
      page1.body.data.map((t: { amount: { amountMinor: number } }) => t.amount.amountMinor),
    ).toEqual([500, 400]);
    expect(page1.body.data[0]).not.toHaveProperty('createdByAdminId');
    const page2 = await request(app)
      .get(`/api/v1/me/transactions?limit=2&cursor=${page1.body.meta.page.nextCursor}`)
      .set(member.auth);
    expect(
      page2.body.data.map((t: { amount: { amountMinor: number } }) => t.amount.amountMinor),
    ).toEqual([300, 200]);
  });

  it("never shows another user's transaction", async () => {
    const other = await createUser(prisma);
    const res = await request(app)
      .post(`/api/v1/admin/users/${other.id}/cash-payments`)
      .set(admin.auth)
      .set('idempotency-key', key())
      .send({ amountMinor: 100 });
    const theirs = await request(app)
      .get(`/api/v1/me/transactions/${res.body.data.transaction.id}`)
      .set(member.auth);
    expect(theirs.status).toBe(404);
  });

  it('lists debts with their training', async () => {
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 1000 });
    const res = await request(app).get('/api/v1/me/debts').set(member.auth);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        status: 'OPEN',
        source: 'TRAINING_CHARGE',
        outstandingAmount: { amountMinor: 1000, currency: 'EUR' },
        trainingId: expect.any(String),
      }),
    ]);
  });
});

describe('admin corrections over HTTP', () => {
  it('reverses a cash payment and marks the original REVERSED', async () => {
    const paid = await cash(1000);
    const reversed = await request(app)
      .post(`/api/v1/admin/transactions/${paid.body.data.transaction.id}/reversal`)
      .set(admin.auth)
      .set('idempotency-key', key())
      .send({ reason: 'Recorded for the wrong member' });
    expect(reversed.status).toBe(201);
    const detail = await request(app)
      .get(`/api/v1/admin/transactions/${paid.body.data.transaction.id}`)
      .set(admin.auth);
    expect(detail.body.data.transaction.status).toBe('REVERSED');
    expect(detail.body.data.related.map((t: { type: string }) => t.type)).toContain('REVERSAL');
  });

  it('refuses a reversal without a reason', async () => {
    const paid = await cash(1000);
    const res = await request(app)
      .post(`/api/v1/admin/transactions/${paid.body.data.transaction.id}/reversal`)
      .set(admin.auth)
      .set('idempotency-key', key())
      .send({});
    expect(res.status).toBe(400);
  });

  it('waives debt with an audited adjustment', async () => {
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 800 });
    const res = await request(app)
      .post(`/api/v1/admin/users/${userId}/adjustments`)
      .set(admin.auth)
      .set('idempotency-key', key())
      .send({ kind: 'DEBT_WAIVER', amountMinor: 800, reason: 'Injury, agreed with coach' });
    expect(res.body.data.wallet.debt.amountMinor).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: 'wallet.adjustment_debt_waiver' } }),
    ).toBe(1);
  });

  it('lists wallets sorted by debt and filters the ledger by admin', async () => {
    await cash(300);
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 1000 });
    const wallets = await request(app)
      .get('/api/v1/admin/wallets?sort=-debt&hasDebt=true')
      .set(admin.auth);
    expect(wallets.body.data[0]).toMatchObject({ userId, debt: { amountMinor: 700 } });
    const byAdmin = await request(app)
      .get(`/api/v1/admin/transactions?adminId=${adminId}`)
      .set(admin.auth);
    expect(
      byAdmin.body.data.every((t: { createdByAdminId: string }) => t.createdByAdminId === adminId),
    ).toBe(true);
    expect(byAdmin.body.meta.page.total).toBe(1);
  });
});
