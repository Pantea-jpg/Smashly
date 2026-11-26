import type { PrismaClient } from '../../core/db/prisma';
import { localDate } from '../trainings/domain/schedule';
import { notifyUsersNow } from './notify';
import { localMinutes } from './push.service';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * D22 training reminders for ATTENDING members. A reminder goes out once the training is
 * within `hoursBefore` (and still more than `notBeforeHours` away, so the 24 h reminder is
 * not sent next to the 2 h one). Members who responded inside the window already know and
 * are skipped. The job runs every few minutes; dedupe keys make repeats no-ops.
 */
export const TRAINING_REMINDER_WINDOWS = [
  { window: '24h', hoursBefore: 24, notBeforeHours: 2 },
  { window: '2h', hoursBefore: 2, notBeforeHours: 0 },
] as const;

/** D22 debt reminders: weekly, once the oldest open debt is a few days old, in daytime. */
export const DEBT_REMINDER = {
  intervalMs: 7 * DAY_MS,
  minDebtAgeMs: 3 * DAY_MS,
  /** Local hours [from, to) in which the job sends; quiet hours still apply on top. */
  localHours: [10, 20] as const,
};

export class ReminderJobs {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Returns the number of reminder notifications created. */
  async trainingReminders(): Promise<number> {
    const now = this.now();
    let created = 0;
    for (const { window, hoursBefore, notBeforeHours } of TRAINING_REMINDER_WINDOWS) {
      const trainings = await this.prisma.training.findMany({
        where: {
          deletedAt: null,
          status: 'SCHEDULED',
          startsAt: {
            gt: new Date(now.getTime() + notBeforeHours * HOUR_MS),
            lte: new Date(now.getTime() + hoursBefore * HOUR_MS),
          },
        },
        select: {
          id: true,
          title: true,
          startsAt: true,
          reservations: {
            where: {
              status: 'ATTENDING',
              user: { status: 'ACTIVE', deletedAt: null },
            },
            select: { userId: true, respondedAt: true },
          },
        },
      });
      for (const training of trainings) {
        const windowOpened = training.startsAt.getTime() - hoursBefore * HOUR_MS;
        const userIds = training.reservations
          .filter((r) => r.respondedAt.getTime() <= windowOpened)
          .map((r) => r.userId);
        const ids = await notifyUsersNow(this.prisma, {
          userIds,
          type: 'TRAINING_REMINDER',
          category: 'REMINDERS',
          params: {
            trainingId: training.id,
            title: training.title,
            startsAt: training.startsAt.toISOString(),
            window,
          },
          dedupeKey: `reminder:${window}:${training.id}`,
        });
        created += ids.length;
      }
    }
    return created;
  }

  /** Returns the number of debt reminders created. */
  async debtReminders(): Promise<number> {
    const now = this.now();
    const wallets = await this.prisma.wallet.findMany({
      where: { debtMinor: { gt: 0 }, user: { status: 'ACTIVE', deletedAt: null } },
      select: {
        userId: true,
        debtMinor: true,
        currency: true,
        user: { select: { profile: { select: { timezone: true } } } },
      },
    });
    let created = 0;
    for (const wallet of wallets) {
      const timeZone = wallet.user.profile?.timezone ?? 'Europe/Amsterdam';
      const hour = Math.floor(localMinutes(now, timeZone) / 60);
      if (hour < DEBT_REMINDER.localHours[0] || hour >= DEBT_REMINDER.localHours[1]) continue;

      const oldest = await this.prisma.debt.findFirst({
        where: { userId: wallet.userId, status: 'OPEN', outstandingAmountMinor: { gt: 0 } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      if (!oldest || oldest.createdAt.getTime() > now.getTime() - DEBT_REMINDER.minDebtAgeMs) {
        continue;
      }
      const recent = await this.prisma.notification.findFirst({
        where: {
          userId: wallet.userId,
          type: 'DEBT_REMINDER',
          createdAt: { gt: new Date(now.getTime() - DEBT_REMINDER.intervalMs) },
        },
        select: { id: true },
      });
      if (recent) continue;

      const ids = await notifyUsersNow(this.prisma, {
        userIds: [wallet.userId],
        type: 'DEBT_REMINDER',
        category: 'REMINDERS',
        params: { amountMinor: wallet.debtMinor, currency: wallet.currency },
        dedupeKey: `debt-reminder:${localDate(now, timeZone)}`,
      });
      created += ids.length;
    }
    return created;
  }
}
