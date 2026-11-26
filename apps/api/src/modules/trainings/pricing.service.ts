import { writeAudit } from '../../core/audit/audit';
import type { AuditContext } from '../../core/context/request-context';
import type { PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import { DEFAULT_CURRENCY } from '@tw/money';
import { currencyOf, money } from '../wallets/mappers';
import {
  findTraining,
  lockTraining,
  notifyUsers,
  pricesFor,
  trainingPeople,
} from './training-support';
import { requireAdmin } from './trainings.service';

/** D5 price levels: a per-training override and a standing price per member. */
export class PricingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every relevant member's final price for one training and where it comes from. */
  async list(trainingId: string) {
    const training = await findTraining(this.prisma, trainingId);
    const people = await trainingPeople(this.prisma, trainingId);
    const prices = await pricesFor(
      this.prisma,
      training,
      people.map((p) => p.id),
    );
    const currency = currencyOf(training.currency);
    return people.map((user) => {
      const price = prices.get(user.id)!;
      return { user, price: money(price.priceMinor, currency), source: price.source };
    });
  }

  async setOverride(
    trainingId: string,
    userId: string,
    priceMinor: number | null,
    ctx: AuditContext,
  ): Promise<void> {
    const adminId = requireAdmin(ctx);
    await this.prisma.$transaction(async (tx) => {
      const training = await lockTraining(tx, trainingId);
      await this.requireMember(tx, userId);
      const before = (await pricesFor(tx, training, [userId])).get(userId)!;
      const existing = await tx.trainingPriceOverride.findUnique({
        where: { trainingId_userId: { trainingId, userId } },
      });
      if (priceMinor === null) {
        if (!existing) return;
        await tx.trainingPriceOverride.delete({ where: { id: existing.id } });
      } else {
        await tx.trainingPriceOverride.upsert({
          where: { trainingId_userId: { trainingId, userId } },
          create: { trainingId, userId, priceMinor, setById: adminId },
          update: { priceMinor, setById: adminId },
        });
      }
      const after = (await pricesFor(tx, training, [userId])).get(userId)!;
      await writeAudit(tx, ctx, {
        action: priceMinor === null ? 'price_override.removed' : 'price_override.set',
        entityType: 'Training',
        entityId: trainingId,
        before: { userId, priceMinor: existing?.priceMinor ?? null },
        after: { userId, priceMinor },
      });
      // D6: a member who reserved hears about a price change before it is charged.
      const reserved = await tx.trainingReservation.findFirst({
        where: { trainingId, userId, status: 'ATTENDING' },
      });
      if (reserved && !training.attendanceFinalizedAt && before.priceMinor !== after.priceMinor) {
        await notifyUsers(tx, {
          userIds: [userId],
          type: 'TRAINING_UPDATED',
          category: 'TRAININGS',
          params: {
            trainingId,
            title: training.title,
            startsAt: training.startsAt.toISOString(),
            changes: ['price'],
            price: money(after.priceMinor, training.currency),
          },
          dedupeKey: `price:${trainingId}:${userId}:${this.now().getTime()}`,
        });
      }
    });
  }

  async getStanding(userId: string) {
    await this.requireMember(this.prisma, userId);
    const row = await this.prisma.userStandingPrice.findUnique({ where: { userId } });
    return { userId, price: row ? money(row.priceMinor, row.currency) : null };
  }

  async setStanding(userId: string, priceMinor: number | null, ctx: AuditContext) {
    const adminId = requireAdmin(ctx);
    await this.prisma.$transaction(async (tx) => {
      await this.requireMember(tx, userId);
      const before = await tx.userStandingPrice.findUnique({ where: { userId } });
      if (priceMinor === null) {
        if (before) await tx.userStandingPrice.delete({ where: { userId } });
      } else {
        await tx.userStandingPrice.upsert({
          where: { userId },
          create: { userId, priceMinor, currency: DEFAULT_CURRENCY, setById: adminId },
          update: { priceMinor, setById: adminId },
        });
      }
      await writeAudit(tx, ctx, {
        action: priceMinor === null ? 'standing_price.removed' : 'standing_price.set',
        entityType: 'User',
        entityId: userId,
        before: { priceMinor: before?.priceMinor ?? null },
        after: { priceMinor },
      });
    });
    return this.getStanding(userId);
  }

  private async requireMember(db: Pick<PrismaClient, 'user'>, userId: string): Promise<void> {
    const member = await db.user.findFirst({
      where: { id: userId, role: 'USER', deletedAt: null },
      select: { id: true },
    });
    if (!member) throw AppError.notFound('User');
  }
}
