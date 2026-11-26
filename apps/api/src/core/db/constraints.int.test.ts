import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { createUser } from '../../../test/fixtures';

const prisma = useTestDatabase();

/**
 * The database is the last line of defence for financial integrity. These tests prove the
 * guarantees hold even if application code is wrong.
 */
async function walletOf(userId: string) {
  return prisma.wallet.findFirstOrThrow({ where: { userId } });
}

async function insertLedgerRow(
  userId: string,
  overrides: Partial<{
    type: 'CASH_TOP_UP' | 'ADJUSTMENT' | 'REVERSAL';
    amountMinor: number;
    walletDeltaMinor: number;
    balanceBeforeMinor: number;
    balanceAfterMinor: number;
    reason: string | null;
    createdByAdminId: string | null;
    sequence: number;
  }> = {},
) {
  const wallet = await walletOf(userId);
  const admin =
    overrides.createdByAdminId === undefined ? await createUser(prisma, { role: 'ADMIN' }) : null;
  return prisma.walletTransaction.create({
    data: {
      walletId: wallet.id,
      userId,
      sequence: overrides.sequence ?? 1,
      type: overrides.type ?? 'CASH_TOP_UP',
      amountMinor: overrides.amountMinor ?? 1000,
      walletDeltaMinor: overrides.walletDeltaMinor ?? 1000,
      debtDeltaMinor: 0,
      balanceBeforeMinor: overrides.balanceBeforeMinor ?? 0,
      balanceAfterMinor: overrides.balanceAfterMinor ?? 1000,
      debtBeforeMinor: 0,
      debtAfterMinor: 0,
      currency: 'EUR',
      paymentMethod: 'CASH',
      description: 'test',
      reason: overrides.reason ?? null,
      idempotencyKey: randomUUID(),
      groupId: randomUUID(),
      createdByAdminId:
        overrides.createdByAdminId === undefined ? admin!.id : overrides.createdByAdminId,
    },
  });
}

describe('wallet constraints', () => {
  it('rejects a negative balance or debt', async () => {
    const user = await createUser(prisma);
    const wallet = await walletOf(user.id);
    await expect(
      prisma.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: -1 } }),
    ).rejects.toThrow(/wallets_balance_nonneg/);
    await expect(
      prisma.wallet.update({ where: { id: wallet.id }, data: { debtMinor: -1 } }),
    ).rejects.toThrow(/wallets_debt_nonneg/);
  });

  it('allows only one wallet per user and currency', async () => {
    const user = await createUser(prisma);
    await expect(
      prisma.wallet.create({ data: { userId: user.id, currency: 'EUR' } }),
    ).rejects.toThrow();
  });

  it('forbids deleting a wallet', async () => {
    const user = await createUser(prisma);
    const wallet = await walletOf(user.id);
    await expect(prisma.wallet.delete({ where: { id: wallet.id } })).rejects.toThrow(/not allowed/);
  });
});

describe('ledger constraints', () => {
  it('accepts a consistent row', async () => {
    const user = await createUser(prisma);
    await expect(insertLedgerRow(user.id)).resolves.toBeDefined();
  });

  it('rejects a broken balance chain', async () => {
    const user = await createUser(prisma);
    await expect(insertLedgerRow(user.id, { balanceAfterMinor: 999 })).rejects.toThrow(
      /wt_balance_chain/,
    );
  });

  it('rejects a row that would leave the balance negative', async () => {
    const user = await createUser(prisma);
    await expect(
      insertLedgerRow(user.id, {
        type: 'ADJUSTMENT',
        amountMinor: 500,
        walletDeltaMinor: -500,
        balanceBeforeMinor: 0,
        balanceAfterMinor: -500,
        reason: 'test',
      }),
    ).rejects.toThrow(/wt_nonneg/);
  });

  it('requires an admin on cash top-ups and a reason on adjustments', async () => {
    const user = await createUser(prisma);
    await expect(insertLedgerRow(user.id, { createdByAdminId: null })).rejects.toThrow(
      /wt_admin_for_cash/,
    );
    await expect(insertLedgerRow(user.id, { type: 'ADJUSTMENT', reason: '  ' })).rejects.toThrow(
      /wt_reason_required/,
    );
  });

  it('requires a REVERSAL to reference the reversed row', async () => {
    const user = await createUser(prisma);
    await expect(insertLedgerRow(user.id, { type: 'REVERSAL', reason: 'oops' })).rejects.toThrow(
      /wt_reversal_link/,
    );
  });

  it('enforces a unique sequence per wallet', async () => {
    const user = await createUser(prisma);
    await insertLedgerRow(user.id, { sequence: 1 });
    await expect(insertLedgerRow(user.id, { sequence: 1 })).rejects.toThrow();
  });

  it('is append-only: UPDATE and DELETE are rejected by the database', async () => {
    const user = await createUser(prisma);
    const row = await insertLedgerRow(user.id);
    await expect(
      prisma.walletTransaction.update({ where: { id: row.id }, data: { description: 'edited' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.walletTransaction.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    const entry = await prisma.auditLog.create({ data: { action: 'test', entityType: 'Test' } });
    await expect(
      prisma.auditLog.update({ where: { id: entry.id }, data: { action: 'changed' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('training charges', () => {
  it('allow only one ACTIVE charge per user and training, but a new one after reversal', async () => {
    const admin = await createUser(prisma, { role: 'ADMIN' });
    const user = await createUser(prisma);
    const wallet = await walletOf(user.id);
    const training = await prisma.training.create({
      data: {
        title: 'Tuesday',
        location: 'Hall A',
        startsAt: new Date('2026-12-01T18:00:00Z'),
        endsAt: new Date('2026-12-01T19:30:00Z'),
        reservationDeadline: new Date('2026-12-01T12:00:00Z'),
        defaultPriceMinor: 1000,
        createdById: admin.id,
      },
    });
    const attendance = await prisma.attendance.create({
      data: { trainingId: training.id, userId: user.id, status: 'PRESENT' },
    });
    const charge = {
      trainingId: training.id,
      userId: user.id,
      walletId: wallet.id,
      attendanceId: attendance.id,
      unitPriceMinor: 1000,
      priceSource: 'TRAINING_DEFAULT' as const,
      currency: 'EUR',
      paidFromWalletMinor: 600,
      shortfallMinor: 400,
    };
    const first = await prisma.trainingCharge.create({ data: charge });
    await expect(prisma.trainingCharge.create({ data: charge })).rejects.toThrow();

    await prisma.trainingCharge.update({ where: { id: first.id }, data: { status: 'REVERSED' } });
    await expect(prisma.trainingCharge.create({ data: charge })).resolves.toBeDefined();
    await expect(prisma.trainingCharge.delete({ where: { id: first.id } })).rejects.toThrow(
      /not allowed/,
    );
  });

  it('rejects a charge whose split does not add up', async () => {
    const admin = await createUser(prisma, { role: 'ADMIN' });
    const user = await createUser(prisma);
    const wallet = await walletOf(user.id);
    const training = await prisma.training.create({
      data: {
        title: 'T',
        location: 'L',
        startsAt: new Date('2026-12-01T18:00:00Z'),
        endsAt: new Date('2026-12-01T19:00:00Z'),
        reservationDeadline: new Date('2026-12-01T12:00:00Z'),
        defaultPriceMinor: 1000,
        createdById: admin.id,
      },
    });
    const attendance = await prisma.attendance.create({
      data: { trainingId: training.id, userId: user.id, status: 'PRESENT' },
    });
    await expect(
      prisma.trainingCharge.create({
        data: {
          trainingId: training.id,
          userId: user.id,
          walletId: wallet.id,
          attendanceId: attendance.id,
          unitPriceMinor: 1000,
          priceSource: 'TRAINING_DEFAULT',
          currency: 'EUR',
          paidFromWalletMinor: 600,
          shortfallMinor: 300,
        },
      }),
    ).rejects.toThrow(/charge_split/);
  });
});

describe('trainings', () => {
  it('reject an end before the start and a deadline after the start', async () => {
    const admin = await createUser(prisma, { role: 'ADMIN' });
    const base = {
      title: 'T',
      location: 'L',
      defaultPriceMinor: 1000,
      createdById: admin.id,
      startsAt: new Date('2026-12-01T18:00:00Z'),
      endsAt: new Date('2026-12-01T19:00:00Z'),
      reservationDeadline: new Date('2026-12-01T12:00:00Z'),
    };
    await expect(
      prisma.training.create({ data: { ...base, endsAt: new Date('2026-12-01T17:00:00Z') } }),
    ).rejects.toThrow(/training_times/);
    await expect(
      prisma.training.create({
        data: { ...base, reservationDeadline: new Date('2026-12-01T18:30:00Z') },
      }),
    ).rejects.toThrow(/training_deadline/);
  });
});

describe('users', () => {
  it('store emails in lower case only', async () => {
    await expect(
      prisma.user.create({ data: { email: 'Mixed@Example.test', passwordHash: 'x' } }),
    ).rejects.toThrow(/users_email_lowercase/);
  });
});
