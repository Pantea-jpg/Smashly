import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { createUser } from '../../../test/fixtures';
import { adminContext, chargeFor, ledgerFor } from '../../../test/money';
import { HOUR, testClock } from '../../../test/trainings';
import { ReminderJobs } from './reminder-jobs';

const prisma = useTestDatabase();
const ledger = ledgerFor(prisma);
const DAY = 24 * HOUR;
// 12:00 in Amsterdam, inside the debt reminders' daytime window.
const clock = testClock(Date.parse('2026-11-25T11:00:00Z'));
const jobs = new ReminderJobs(prisma, clock.now);
let adminId: string;

beforeEach(async () => {
  clock.set(Date.parse('2026-11-25T11:00:00Z'));
  adminId = (await createUser(prisma, { role: 'ADMIN' })).id;
});

async function training(startsInMs: number) {
  const startsAt = new Date(clock.ms + startsInMs);
  return prisma.training.create({
    data: {
      title: 'Tuesday club',
      location: 'Hall A',
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR),
      reservationDeadline: startsAt,
      defaultPriceMinor: 1000,
      createdById: adminId,
    },
  });
}

async function reserve(
  trainingId: string,
  userId: string,
  respondedAgoMs: number,
  status: 'ATTENDING' | 'NOT_ATTENDING' = 'ATTENDING',
) {
  await prisma.trainingReservation.create({
    data: {
      trainingId,
      userId,
      status,
      respondedById: userId,
      respondedAt: new Date(clock.ms - respondedAgoMs),
    },
  });
}

const reminders = (type: 'TRAINING_REMINDER' | 'DEBT_REMINDER' | 'LOW_BALANCE') =>
  prisma.notification.findMany({ where: { type }, orderBy: { createdAt: 'asc' } });

describe('training reminders (D22)', () => {
  it('reminds attending members 24 h before, once, and not those who just responded', async () => {
    const t = await training(23 * HOUR);
    const early = await createUser(prisma);
    const late = await createUser(prisma);
    const notComing = await createUser(prisma);
    await reserve(t.id, early.id, 3 * DAY);
    await reserve(t.id, late.id, 10 * 60_000); // responded inside the 24 h window
    await reserve(t.id, notComing.id, 3 * DAY, 'NOT_ATTENDING');

    expect(await jobs.trainingReminders()).toBe(1);
    expect(await jobs.trainingReminders()).toBe(0); // next run: deduplicated
    const [reminder] = await reminders('TRAINING_REMINDER');
    expect(reminder).toMatchObject({
      userId: early.id,
      category: 'REMINDERS',
      dedupeKey: `reminder:24h:${t.id}`,
      params: { trainingId: t.id, window: '24h', startsAt: t.startsAt.toISOString() },
    });
    // The push is queued with the notification.
    expect(await prisma.outboxEvent.count({ where: { type: 'notification.push' } })).toBe(1);
  });

  it('sends the 2 h reminder (only) once the training is that close', async () => {
    const t = await training(90 * 60_000);
    const m = await createUser(prisma);
    await reserve(t.id, m.id, DAY);
    expect(await jobs.trainingReminders()).toBe(1);
    expect((await reminders('TRAINING_REMINDER')).map((r) => r.dedupeKey)).toEqual([
      `reminder:2h:${t.id}`,
    ]);
  });

  it('sends both reminders over time, and none for cancelled or past trainings', async () => {
    const t = await training(30 * HOUR);
    const cancelled = await training(20 * HOUR);
    await prisma.training.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } });
    const m = await createUser(prisma);
    await reserve(t.id, m.id, 2 * DAY);
    await reserve(cancelled.id, m.id, 2 * DAY);

    expect(await jobs.trainingReminders()).toBe(0); // 30 h away
    clock.advance(7 * HOUR); // 23 h away
    expect(await jobs.trainingReminders()).toBe(1);
    clock.advance(21.5 * HOUR); // 1.5 h away
    expect(await jobs.trainingReminders()).toBe(1);
    clock.advance(2 * HOUR); // started
    expect(await jobs.trainingReminders()).toBe(0);
    expect((await reminders('TRAINING_REMINDER')).map((r) => r.params)).toMatchObject([
      { window: '24h' },
      { window: '2h' },
    ]);
  });
});

describe('debt reminders (D22)', () => {
  async function memberWithDebt(debtAgeMs: number) {
    const m = await createUser(prisma);
    await chargeFor(prisma, ledger, { adminId, userId: m.id, priceMinor: 800 });
    await prisma.debt.updateMany({
      where: { userId: m.id },
      data: { createdAt: new Date(clock.ms - debtAgeMs) },
    });
    return m;
  }

  it('reminds weekly once the debt is a few days old', async () => {
    const m = await memberWithDebt(4 * DAY);
    await memberWithDebt(DAY); // too recent
    expect(await jobs.debtReminders()).toBe(1);
    expect(await jobs.debtReminders()).toBe(0);
    const [reminder] = await reminders('DEBT_REMINDER');
    expect(reminder).toMatchObject({ userId: m.id, params: { amountMinor: 800, currency: 'EUR' } });
  });

  it('only sends in daytime, local time', async () => {
    await memberWithDebt(4 * DAY);
    clock.set(Date.parse('2026-11-25T21:00:00Z')); // 22:00 in Amsterdam
    expect(await jobs.debtReminders()).toBe(0);
  });

  it('stops once the debt is paid', async () => {
    const m = await memberWithDebt(4 * DAY);
    await ledger.creditCash(
      { userId: m.id, amountMinor: 800, adminId, idempotencyKey: 'pay' },
      adminContext(adminId),
    );
    expect(await jobs.debtReminders()).toBe(0);
  });
});

describe('low balance (D21)', () => {
  it('notifies when a charge takes the balance below the threshold, at most once a week', async () => {
    const m = await createUser(prisma);
    await ledger.creditCash(
      { userId: m.id, amountMinor: 3000, adminId, idempotencyKey: 'top-up' },
      adminContext(adminId),
    );
    await chargeFor(prisma, ledger, { adminId, userId: m.id, priceMinor: 1500 }); // 15.00 left
    expect(await reminders('LOW_BALANCE')).toHaveLength(0);
    await chargeFor(prisma, ledger, { adminId, userId: m.id, priceMinor: 1000 }); // 5.00 left
    await chargeFor(prisma, ledger, { adminId, userId: m.id, priceMinor: 400 }); // still low
    const low = await reminders('LOW_BALANCE');
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({
      category: 'REMINDERS',
      params: { amountMinor: 500, currency: 'EUR' },
    });

    // Topping up and dropping again within 7 days stays quiet.
    await ledger.creditCash(
      { userId: m.id, amountMinor: 2000, adminId, idempotencyKey: 'top-up-2' },
      adminContext(adminId),
    );
    await chargeFor(prisma, ledger, { adminId, userId: m.id, priceMinor: 1500 });
    expect(await reminders('LOW_BALANCE')).toHaveLength(1);
  });

  it('does not notify on a credit that leaves the balance under the threshold', async () => {
    const m = await createUser(prisma);
    await ledger.creditCash(
      { userId: m.id, amountMinor: 500, adminId, idempotencyKey: 'small' },
      adminContext(adminId),
    );
    expect(await reminders('LOW_BALANCE')).toHaveLength(0);
  });
});
