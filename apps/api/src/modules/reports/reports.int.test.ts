import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser } from '../../../test/fixtures';
import { adminContext, chargeFor, ledgerFor } from '../../../test/money';
import { loginAs, type TestSession } from '../../../test/sessions';

const prisma = useTestDatabase();
const { app } = buildTestApp({ prisma });
const ledger = ledgerFor(prisma);

let admin: TestSession;
let adminId: string;
let userId: string;
const cash = (amountMinor: number) =>
  ledger.creditCash(
    { userId, amountMinor, adminId, idempotencyKey: randomUUID() },
    adminContext(adminId),
  );

beforeEach(async () => {
  const a = await createUser(prisma, { role: 'ADMIN' });
  adminId = a.id;
  admin = await loginAs(app, a);
  userId = (await createUser(prisma)).id;
  await prisma.userProfile.update({
    where: { userId },
    data: { firstName: '=HYPERLINK("http://evil")', lastName: 'Smith' },
  });
});

describe('financial summary (D20: charged vs collected)', () => {
  it('follows the €10 / €6 example through to settlement', async () => {
    await cash(600);
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 1000 });

    let summary = (await request(app).get('/api/v1/admin/reports/summary').set(admin.auth)).body
      .data;
    expect(summary.trainingRevenue).toEqual({
      charged: { amountMinor: 1000, currency: 'EUR' },
      collected: { amountMinor: 600, currency: 'EUR' },
      outstanding: { amountMinor: 400, currency: 'EUR' },
    });
    expect(summary.debt.created.amountMinor).toBe(400);

    await cash(5000);
    summary = (await request(app).get('/api/v1/admin/reports/summary').set(admin.auth)).body.data;
    expect(summary.trainingRevenue.collected.amountMinor).toBe(1000);
    expect(summary.trainingRevenue.outstanding.amountMinor).toBe(0);
    expect(summary.debt.settled.amountMinor).toBe(400);
    expect(summary.topUps.cash.amountMinor).toBe(5600);
  });
});

describe('dashboard', () => {
  it('shows totals, period KPIs and what needs attention', async () => {
    await cash(2000);
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 2500 });
    const res = await request(app).get('/api/v1/admin/dashboard').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      users: { total: 1, active: 1 },
      totalWalletBalances: { amountMinor: 0 },
      outstandingDebt: { amountMinor: 500 },
      cashPayments: { amountMinor: 2000 },
      trainingRevenue: { amountMinor: 2500 },
      // The test training ended without finalization.
      needsAttention: { trainingsAwaitingFinalization: 1, paymentsRequiringReview: 0 },
    });
    expect(res.body.data.recentTransactions).toHaveLength(2);
  });

  it('rejects inverted or overly long periods', async () => {
    expect(
      (
        await request(app)
          .get('/api/v1/admin/dashboard?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z')
          .set(admin.auth)
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get('/api/v1/admin/dashboard?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z')
          .set(admin.auth)
      ).status,
    ).toBe(400);
  });
});

describe('revenue, debt aging and cash per admin', () => {
  it('groups by month, buckets debt by age and attributes cash to the admin', async () => {
    await cash(1500);
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 2000 });

    const revenue = (
      await request(app).get('/api/v1/admin/reports/revenue?groupBy=month').set(admin.auth)
    ).body.data;
    expect(revenue).toHaveLength(1);
    expect(revenue[0]).toMatchObject({
      charged: { amountMinor: 2000 },
      cashTopUps: { amountMinor: 1500 },
    });
    expect(revenue[0].period).toMatch(/^\d{4}-\d{2}$/);

    const aging = (await request(app).get('/api/v1/admin/reports/debts').set(admin.auth)).body.data;
    expect(aging.total.amountMinor).toBe(500);
    expect(aging.buckets[0]).toMatchObject({
      label: '0-30',
      amount: { amountMinor: 500 },
      count: 1,
    });

    const cashReport = (await request(app).get('/api/v1/admin/reports/cash').set(admin.auth)).body
      .data;
    expect(cashReport.admins).toEqual([
      expect.objectContaining({ adminId, count: 1, total: { amountMinor: 1500, currency: 'EUR' } }),
    ]);
  });
});

describe('CSV exports', () => {
  it('downloads with BOM, decimal amounts and formula injection neutralised', async () => {
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 1250 });
    const res = await request(app).get('/api/v1/admin/reports/debts.csv').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('outstanding-debt.csv');
    expect(res.text.startsWith('﻿user_id,email,first_name')).toBe(true);
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(res.text).toContain(',EUR,12.50,');

    const ledgerCsv = await request(app).get('/api/v1/admin/reports/ledger.csv').set(admin.auth);
    expect(ledgerCsv.text).toContain('TRAINING_PAYMENT');
    // amount, wallet_delta, debt_delta: an unfunded charge only increases debt.
    expect(ledgerCsv.text).toContain(',EUR,12.50,0.00,12.50,');
  });
});

describe('reconciliation', () => {
  it('passes on consistent books and reports a tampered wallet', async () => {
    await cash(1000);
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 1500 });

    const clean = await request(app).post('/api/v1/admin/reconciliation/run').set(admin.auth);
    expect(clean.body.data).toMatchObject({ walletsChecked: 1, issues: [] });

    // Simulate a bug or a manual database edit that bypassed the ledger.
    await prisma.$executeRaw`UPDATE wallets SET balance_minor = balance_minor + 999 WHERE user_id = ${userId}::uuid`;
    const dirty = await request(app).post('/api/v1/admin/reconciliation/run').set(admin.auth);
    expect(dirty.body.data.issues).toEqual([
      expect.objectContaining({ check: 'wallet_totals_match_ledger', entityType: 'Wallet' }),
    ]);

    const dashboard = await request(app).get('/api/v1/admin/dashboard').set(admin.auth);
    expect(dashboard.body.data.needsAttention.reconciliationIssues).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'reconciliation.run' } })).toBe(2);
  });
});
