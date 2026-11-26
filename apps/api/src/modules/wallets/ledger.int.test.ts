import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { createUser } from '../../../test/fixtures';
import { adminContext, chargeFor, ledgerFor, walletOf } from '../../../test/money';
import { SettingsService } from '../admin/settings.service';
import { ReconciliationService } from '../reports/reconciliation.service';

const prisma = useTestDatabase();
const ledger = ledgerFor(prisma);

let adminId: string;
let userId: string;
const ctx = () => adminContext(adminId);
const cash = (amountMinor: number, key: string = randomUUID()) =>
  ledger.creditCash({ userId, amountMinor, adminId, idempotencyKey: key }, ctx());

beforeEach(async () => {
  adminId = (await createUser(prisma, { role: 'ADMIN' })).id;
  userId = (await createUser(prisma)).id;
});

async function ledgerRows() {
  return prisma.walletTransaction.findMany({ where: { userId }, orderBy: { sequence: 'asc' } });
}

describe('the specification example: €10 fee, €6 balance, then a €50 top-up', () => {
  it('charges €6 + €4 debt, then settles the debt automatically with a ledger row', async () => {
    await cash(600);
    const { chargeId, result } = await chargeFor(prisma, ledger, {
      adminId,
      userId,
      priceMinor: 1000,
    });
    expect(result?.wallet).toEqual({
      balance: { amountMinor: 0, currency: 'EUR' },
      debt: { amountMinor: 400, currency: 'EUR' },
    });
    const charge = await prisma.trainingCharge.findUniqueOrThrow({
      where: { id: chargeId },
      include: { debt: true },
    });
    expect(charge).toMatchObject({
      unitPriceMinor: 1000,
      paidFromWalletMinor: 600,
      shortfallMinor: 400,
    });
    expect(charge.debt).toMatchObject({
      originalAmountMinor: 400,
      outstandingAmountMinor: 400,
      status: 'OPEN',
    });

    const topUp = await cash(5000);
    expect(topUp.settlements).toHaveLength(1);
    expect(topUp.settlements[0]).toMatchObject({
      type: 'DEBT_PAYMENT',
      amount: { amountMinor: 400 },
    });
    expect(topUp.wallet.balance.amountMinor).toBe(4600);
    expect(topUp.wallet.debt.amountMinor).toBe(0);

    const rows = await ledgerRows();
    expect(
      rows.map((r) => [
        r.sequence,
        r.type,
        r.walletDeltaMinor,
        r.debtDeltaMinor,
        r.balanceAfterMinor,
        r.debtAfterMinor,
      ]),
    ).toEqual([
      [1, 'CASH_TOP_UP', 600, 0, 600, 0],
      [2, 'TRAINING_PAYMENT', -600, 400, 0, 400],
      [3, 'CASH_TOP_UP', 5000, 0, 5000, 400],
      [4, 'DEBT_PAYMENT', -400, -400, 4600, 0],
    ]);
    expect(rows[3]!.groupId).toBe(rows[2]!.groupId);

    const debt = await prisma.debt.findFirstOrThrow({ include: { settlements: true } });
    expect(debt).toMatchObject({ status: 'SETTLED', outstandingAmountMinor: 0 });
    expect(debt.settlements.map((s) => s.amountMinor)).toEqual([400]);

    const wallet = await walletOf(prisma, userId);
    expect(wallet).toMatchObject({ balanceMinor: 4600, debtMinor: 0, sequence: 4 });
    expect(await prisma.notification.count({ where: { userId } })).toBe(3); // 2× cash, 1× charge
    expect(await prisma.auditLog.count({ where: { action: 'wallet.cash_top_up' } })).toBe(2);
  });
});

describe('idempotency and concurrency', () => {
  it('replays the same request instead of crediting twice', async () => {
    const first = await cash(2500, 'same-key-1');
    const second = await cash(2500, 'same-key-1');
    expect(second.transaction.id).toBe(first.transaction.id);
    expect((await walletOf(prisma, userId)).balanceMinor).toBe(2500);
    expect(await prisma.walletTransaction.count()).toBe(1);
  });

  it('serialises 30 concurrent credits: exact balance, gap-free sequence', async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => cash(100 + i)));
    const wallet = await walletOf(prisma, userId);
    const expected = Array.from({ length: 30 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0);
    expect(wallet.balanceMinor).toBe(expected);
    const rows = await ledgerRows();
    expect(rows.map((r) => r.sequence)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    rows
      .slice(1)
      .forEach((row, i) => expect(row.balanceBeforeMinor).toBe(rows[i]!.balanceAfterMinor));
  });

  it('lets only one of many concurrent duplicates through', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => cash(700, 'dup-key')));
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect((await walletOf(prisma, userId)).balanceMinor).toBe(700);
  });

  it('keeps cached totals equal to the ledger under concurrent credits and charges', async () => {
    await Promise.all([
      ...Array.from({ length: 10 }, () => cash(350)),
      ...Array.from({ length: 10 }, () =>
        chargeFor(prisma, ledger, { adminId, userId, priceMinor: 500 }),
      ),
    ]);
    const wallet = await walletOf(prisma, userId);
    const rows = await ledgerRows();
    expect(wallet.balanceMinor).toBe(rows.reduce((s, r) => s + r.walletDeltaMinor, 0));
    expect(wallet.debtMinor).toBe(rows.reduce((s, r) => s + r.debtDeltaMinor, 0));
    // 3500 credited, 5000 charged: exactly 1500 is owed overall.
    expect(wallet.debtMinor - wallet.balanceMinor).toBe(1500);
    const open = await prisma.debt.aggregate({
      where: { status: 'OPEN' },
      _sum: { outstandingAmountMinor: true },
    });
    expect(open._sum.outstandingAmountMinor ?? 0).toBe(wallet.debtMinor);
  });
});

describe('limits and validation', () => {
  it('refuses credits beyond the maximum balance (after settling debt)', async () => {
    await new SettingsService(prisma).set('wallet.maxBalanceMinor', 1000, adminId);
    await cash(800);
    await expect(cash(300)).rejects.toMatchObject({ code: 'BALANCE_LIMIT_EXCEEDED' });
  });

  it('refuses to credit an account without a wallet (admins)', async () => {
    await expect(
      ledger.creditCash({ userId: adminId, amountMinor: 100, adminId, idempotencyKey: 'x' }, ctx()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('adjustments', () => {
  it('a debit cannot overdraw', async () => {
    await cash(300);
    await expect(
      ledger.adjust(
        { userId, kind: 'DEBIT', amountMinor: 301, reason: 'oops', adminId, idempotencyKey: 'a1' },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('a debt waiver forgives the oldest debts first', async () => {
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 300 });
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 500 });
    const res = await ledger.adjust(
      {
        userId,
        kind: 'DEBT_WAIVER',
        amountMinor: 400,
        reason: 'Goodwill',
        adminId,
        idempotencyKey: 'w1',
      },
      ctx(),
    );
    expect(res.wallet.debt.amountMinor).toBe(400);
    const debts = await prisma.debt.findMany({ orderBy: { createdAt: 'asc' } });
    expect(debts.map((d) => [d.status, d.outstandingAmountMinor])).toEqual([
      ['CANCELLED', 0],
      ['OPEN', 400],
    ]);
  });
});

describe('reversals', () => {
  it('reversing a cash top-up that was already spent turns the shortfall into debt (D18)', async () => {
    const topUp = await cash(1000);
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 700 });
    const res = await ledger.reverse(
      { transactionId: topUp.transaction.id, reason: 'Entered twice', adminId },
      ctx(),
    );
    expect(res.transaction).toMatchObject({
      type: 'REVERSAL',
      walletDelta: { amountMinor: -300 },
      debtDelta: { amountMinor: 700 },
    });
    expect(res.wallet).toEqual({
      balance: { amountMinor: 0, currency: 'EUR' },
      debt: { amountMinor: 700, currency: 'EUR' },
    });
    expect(await prisma.debt.count({ where: { source: 'TOP_UP_REVERSAL' } })).toBe(1);

    const original = await prisma.walletTransaction.findUniqueOrThrow({
      where: { id: topUp.transaction.id },
      include: { reversedBy: true },
    });
    expect(original.reversedBy?.id).toBe(res.transaction.id);
    await expect(
      ledger.reverse({ transactionId: topUp.transaction.id, reason: 'again', adminId }, ctx()),
    ).rejects.toMatchObject({
      code: 'ALREADY_REVERSED',
    });
  });

  it('reversing a debit adjustment gives the money back and settles debt', async () => {
    await cash(500);
    const debit = await ledger.adjust(
      { userId, kind: 'DEBIT', amountMinor: 500, reason: 'fee', adminId, idempotencyKey: 'd1' },
      ctx(),
    );
    await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 200 });
    const res = await ledger.reverse(
      { transactionId: debit.transaction.id, reason: 'wrong', adminId },
      ctx(),
    );
    expect(res.settlements).toHaveLength(1);
    expect(res.wallet.balance.amountMinor).toBe(300);
  });

  it('refuses to reverse training charges, online top-ups and debt payments directly', async () => {
    const { result } = await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 500 });
    await expect(
      ledger.reverse({ transactionId: result!.transaction.id, reason: 'x', adminId }, ctx()),
    ).rejects.toMatchObject({
      code: 'NOT_REVERSIBLE',
    });
    const topUp = await cash(1000);
    await expect(
      ledger.reverse({ transactionId: topUp.settlements[0]!.id, reason: 'x', adminId }, ctx()),
    ).rejects.toMatchObject({
      code: 'NOT_REVERSIBLE',
    });
  });
});

describe('reverseTrainingCharge', () => {
  it('returns what was paid (at charge + later debt payments) and cancels the rest', async () => {
    await cash(600);
    const { chargeId } = await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 1000 });
    await cash(100); // settles 100 of the 400 debt
    const res = await ledger.run(undefined, (tx) =>
      ledger.reverseTrainingCharge(tx, { chargeId, reason: 'Was absent', adminId }, ctx()),
    );
    expect(res?.transaction).toMatchObject({
      walletDelta: { amountMinor: 700 },
      debtDelta: { amountMinor: -300 },
    });
    expect(res?.wallet).toEqual({
      balance: { amountMinor: 700, currency: 'EUR' },
      debt: { amountMinor: 0, currency: 'EUR' },
    });

    const debt = await prisma.debt.findFirstOrThrow({ include: { settlements: true } });
    expect(debt.status).toBe('CANCELLED');
    expect(debt.settlements.reduce((s, x) => s + x.amountMinor, 0)).toBe(debt.originalAmountMinor);
    expect(
      (await prisma.trainingCharge.findUniqueOrThrow({ where: { id: chargeId } })).status,
    ).toBe('REVERSED');
  });

  it('does not refund the waived part of a debt', async () => {
    await cash(600);
    const { chargeId } = await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 1000 });
    await ledger.adjust(
      {
        userId,
        kind: 'DEBT_WAIVER',
        amountMinor: 150,
        reason: 'Goodwill',
        adminId,
        idempotencyKey: 'w',
      },
      ctx(),
    );
    const res = await ledger.run(undefined, (tx) =>
      ledger.reverseTrainingCharge(tx, { chargeId, reason: 'x', adminId }, ctx()),
    );
    expect(res?.transaction).toMatchObject({
      walletDelta: { amountMinor: 600 },
      debtDelta: { amountMinor: -250 },
    });
  });

  it('reverses an unpaid, fully waived charge without moving money (found by the simulation)', async () => {
    const { chargeId } = await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 800 });
    await ledger.adjust(
      {
        userId,
        kind: 'DEBT_WAIVER',
        amountMinor: 800,
        reason: 'Goodwill',
        adminId,
        idempotencyKey: 'w-all',
      },
      ctx(),
    );
    const res = await ledger.run(undefined, (tx) =>
      ledger.reverseTrainingCharge(tx, { chargeId, reason: 'x', adminId }, ctx()),
    );
    expect(res).toBeNull();
    expect(
      await prisma.trainingCharge.findUniqueOrThrow({ where: { id: chargeId } }),
    ).toMatchObject({ status: 'REVERSED' });
    expect(await walletOf(prisma, userId)).toMatchObject({
      balanceMinor: 0,
      debtMinor: 0,
      sequence: 2,
    });
    await expect(
      ledger.run(undefined, (tx) =>
        ledger.reverseTrainingCharge(tx, { chargeId, reason: 'x', adminId }, ctx()),
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    expect((await new ReconciliationService(prisma).run()).issues).toEqual([]);
  });

  it('allows charging the same training again after a reversal, never twice at once', async () => {
    const { chargeId } = await chargeFor(prisma, ledger, { adminId, userId, priceMinor: 300 });
    const charge = await prisma.trainingCharge.findUniqueOrThrow({ where: { id: chargeId } });
    const again = () =>
      ledger.run(undefined, (tx) =>
        ledger.chargeTraining(
          tx,
          {
            trainingId: charge.trainingId,
            trainingTitle: 'T',
            userId,
            attendanceId: charge.attendanceId,
            unitPriceMinor: 300,
            priceSource: 'TRAINING_DEFAULT',
            currency: 'EUR',
          },
          ctx(),
        ),
      );
    await expect(again()).rejects.toThrow();
    await ledger.run(undefined, (tx) =>
      ledger.reverseTrainingCharge(tx, { chargeId, reason: 'x', adminId }, ctx()),
    );
    await expect(again()).resolves.toMatchObject({
      result: { transaction: { type: 'TRAINING_PAYMENT' } },
    });
  });

  it('free trainings create a charge but no ledger row', async () => {
    const { chargeId, result } = await chargeFor(prisma, ledger, {
      adminId,
      userId,
      priceMinor: 0,
    });
    expect(result).toBeNull();
    expect(await prisma.walletTransaction.count()).toBe(0);
    const reversed = await ledger.run(undefined, (tx) =>
      ledger.reverseTrainingCharge(tx, { chargeId, reason: 'x', adminId }, ctx()),
    );
    expect(reversed).toBeNull();
  });
});

describe('external debits (Stripe refunds and chargebacks)', () => {
  it('turn an uncovered remainder into debt and are idempotent on the Stripe id', async () => {
    await cash(300);
    const payment = await prisma.payment.create({
      data: {
        userId,
        walletId: (await walletOf(prisma, userId)).id,
        amountMinor: 1000,
        currency: 'EUR',
        clientIdempotencyKey: 'p1',
        status: 'SUCCEEDED',
      },
    });
    const debit = () =>
      ledger.run(undefined, (tx) =>
        ledger.debitExternal(
          tx,
          {
            userId,
            currency: 'EUR',
            amountMinor: 1000,
            idempotencyKey: 'stripe_dispute:dp_1',
            paymentId: payment.id,
            description: 'Chargeback',
            reason: 'Card dispute',
          },
          ctx(),
        ),
      );
    const first = await debit();
    expect(first.created).toBe(true);
    expect(first.result.wallet).toEqual({
      balance: { amountMinor: 0, currency: 'EUR' },
      debt: { amountMinor: 700, currency: 'EUR' },
    });
    const second = await debit();
    expect(second.created).toBe(false);
    expect(await prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(1);
  });
});
