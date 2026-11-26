import type { AdminTraining, AttendanceRow, AttendanceStatus, LedgerResult } from '@tw/contracts';
import { writeAudit } from '../../core/audit/audit';
import type { AuditContext } from '../../core/context/request-context';
import type { Db, PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { LedgerService } from '../wallets/ledger.service';
import { currencyOf, money } from '../wallets/mappers';
import {
  assertNotCancelled,
  assertNotFinalized,
  attendingCounts,
  byName,
  findTraining,
  lockTraining,
  PERSON_SELECT,
  pricesFor,
  toChargeSummary,
  toPerson,
  toTraining,
  type Tx,
} from './training-support';
import { requireAdmin, type TrainingsService } from './trainings.service';
import { notifyUsersNow } from '../notifications/notify';
import { emitRealtime, trainingChanged } from '../realtime/realtime';

/** D13: admins are reminded once a training has been over this long without finalization. */
export const FINALIZE_REMINDER_HOURS = 24;

export class AttendanceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly trainings: TrainingsService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Participants: everyone ATTENDING plus anyone with an attendance row or a charge (walk-ins). */
  async list(trainingId: string, db: Db = this.prisma): Promise<AttendanceRow[]> {
    const training = await findTraining(db, trainingId);
    const [reservations, attendances, charges] = await Promise.all([
      db.trainingReservation.findMany({ where: { trainingId } }),
      db.attendance.findMany({ where: { trainingId } }),
      db.trainingCharge.findMany({ where: { trainingId }, orderBy: { createdAt: 'desc' } }),
    ]);
    const userIds = [
      ...new Set([
        ...reservations.filter((r) => r.status === 'ATTENDING').map((r) => r.userId),
        ...attendances.map((a) => a.userId),
        ...charges.map((c) => c.userId),
      ]),
    ];
    const [users, prices] = await Promise.all([
      db.user.findMany({ where: { id: { in: userIds } }, select: PERSON_SELECT }),
      pricesFor(db, training, userIds),
    ]);
    const currency = currencyOf(training.currency);
    return users
      .map((u) => {
        const attendance = attendances.find((a) => a.userId === u.id);
        const forUser = charges.filter((c) => c.userId === u.id);
        const charge = forUser.find((c) => c.status === 'ACTIVE') ?? forUser[0] ?? null;
        const price = prices.get(u.id)!;
        return {
          user: toPerson(u),
          reservation: reservations.find((r) => r.userId === u.id)?.status ?? null,
          status: attendance?.status ?? ('PENDING' as const),
          note: attendance?.note ?? null,
          markedAt: attendance?.markedAt?.toISOString() ?? null,
          price: { price: money(price.priceMinor, currency), source: price.source },
          charge: charge ? toChargeSummary(charge) : null,
        };
      })
      .sort((a, b) => byName(a.user, b.user));
  }

  /** Marks attendance before finalization. Unknown members are added (walk-ins). */
  async mark(
    trainingId: string,
    entries: { userId: string; status: AttendanceStatus; note?: string | null | undefined }[],
    ctx: AuditContext,
  ): Promise<AttendanceRow[]> {
    const adminId = requireAdmin(ctx);
    return this.prisma.$transaction(async (tx) => {
      const training = await lockTraining(tx, trainingId);
      assertNotCancelled(training);
      assertNotFinalized(training);
      this.assertStarted(training);
      const members = await tx.user.findMany({
        where: { id: { in: entries.map((e) => e.userId) }, role: 'USER', deletedAt: null },
        select: { id: true },
      });
      const missing = entries
        .filter((e) => !members.some((m) => m.id === e.userId))
        .map((e) => e.userId);
      if (missing.length > 0)
        throw AppError.validation({ unknownUsers: missing }, 'Unknown or non-member users');
      const now = this.now();
      for (const entry of entries) {
        const data = {
          status: entry.status,
          ...(entry.note !== undefined ? { note: entry.note } : {}),
          markedById: entry.status === 'PENDING' ? null : adminId,
          markedAt: entry.status === 'PENDING' ? null : now,
        };
        await tx.attendance.upsert({
          where: { trainingId_userId: { trainingId, userId: entry.userId } },
          create: { trainingId, userId: entry.userId, ...data },
          update: data,
        });
      }
      await emitRealtime(tx, trainingChanged(trainingId));
      await writeAudit(tx, ctx, {
        action: 'attendance.marked',
        entityType: 'Training',
        entityId: trainingId,
        after: { entries: entries.map((e) => ({ userId: e.userId, status: e.status })) },
      });
      return this.list(trainingId, tx);
    });
  }

  /**
   * Charges every PRESENT participant at their resolved price (snapshotted, D6) in ONE
   * transaction: either everyone is charged and the training is COMPLETED, or nothing happens.
   * Only PRESENT is charged; ABSENT and EXCUSED never are.
   */
  async finalize(
    trainingId: string,
    input: { pendingAs?: 'ABSENT' | undefined },
    ctx: AuditContext,
  ): Promise<{
    training: AdminTraining;
    charged: number;
    totalCharged: ReturnType<typeof money>;
    paidFromWallets: ReturnType<typeof money>;
    debtCreated: ReturnType<typeof money>;
  }> {
    const adminId = requireAdmin(ctx);
    const outcome = await this.ledger.run(undefined, async (tx) => {
      const training = await lockTraining(tx, trainingId);
      assertNotCancelled(training);
      assertNotFinalized(training);
      this.assertStarted(training);
      const now = this.now();

      // Members who said ATTENDING but were never marked get a PENDING row first.
      const attending = await tx.trainingReservation.findMany({
        where: { trainingId, status: 'ATTENDING' },
        select: { userId: true },
      });
      await tx.attendance.createMany({
        data: attending.map((r) => ({ trainingId, userId: r.userId })),
        skipDuplicates: true,
      });
      const pending = await tx.attendance.count({ where: { trainingId, status: 'PENDING' } });
      if (pending > 0) {
        if (!input.pendingAs) {
          throw new AppError('ATTENDANCE_HAS_PENDING', 'Some participants are still pending', {
            pending,
          });
        }
        await tx.attendance.updateMany({
          where: { trainingId, status: 'PENDING' },
          data: { status: input.pendingAs, markedById: adminId, markedAt: now },
        });
      }

      const present = await tx.attendance.findMany({
        where: { trainingId, status: 'PRESENT' },
        orderBy: { userId: 'asc' },
      });
      const prices = await pricesFor(
        tx,
        training,
        present.map((a) => a.userId),
      );
      let totalCharged = 0;
      let paidFromWallets = 0;
      let debtCreated = 0;
      for (const attendance of present) {
        const price = prices.get(attendance.userId)!;
        const { chargeId } = await this.ledger.chargeTraining(
          tx,
          {
            trainingId,
            trainingTitle: training.title,
            userId: attendance.userId,
            attendanceId: attendance.id,
            unitPriceMinor: price.priceMinor,
            priceSource: price.source,
            currency: training.currency,
          },
          ctx,
        );
        const charge = await tx.trainingCharge.findUniqueOrThrow({ where: { id: chargeId } });
        totalCharged += charge.unitPriceMinor;
        paidFromWallets += charge.paidFromWalletMinor;
        debtCreated += charge.shortfallMinor;
      }

      const finalized = await tx.training.update({
        where: { id: trainingId },
        data: { status: 'COMPLETED', attendanceFinalizedAt: now, attendanceFinalizedById: adminId },
      });
      await emitRealtime(tx, trainingChanged(trainingId));
      await writeAudit(tx, ctx, {
        action: 'attendance.finalized',
        entityType: 'Training',
        entityId: trainingId,
        after: {
          charged: present.length,
          totalCharged,
          debtCreated,
          pendingAs: input.pendingAs ?? null,
          pendingConverted: pending,
        },
      });
      return { finalized, charged: present.length, totalCharged, paidFromWallets, debtCreated };
    });
    const currency = currencyOf(outcome.finalized.currency);
    return {
      training: await this.trainings.adminTraining(outcome.finalized),
      charged: outcome.charged,
      totalCharged: money(outcome.totalCharged, currency),
      paidFromWallets: money(outcome.paidFromWallets, currency),
      debtCreated: money(outcome.debtCreated, currency),
    };
  }

  /**
   * D11: after finalization an admin corrects one member's attendance with a reason.
   * PRESENT → not present reverses the charge; not present → PRESENT charges at the price that
   * applies now (override → standing → default).
   */
  async correct(
    trainingId: string,
    userId: string,
    input: { status: 'PRESENT' | 'ABSENT' | 'EXCUSED'; reason: string },
    ctx: AuditContext,
  ): Promise<{
    attendance: AttendanceRow;
    reversal: LedgerResult | null;
    charge: LedgerResult | null;
  }> {
    const adminId = requireAdmin(ctx);
    return this.ledger.run(undefined, async (tx) => {
      const training = await lockTraining(tx, trainingId);
      assertNotCancelled(training);
      if (!training.attendanceFinalizedAt) {
        throw new AppError('CONFLICT', 'Attendance is not finalized yet; mark it directly instead');
      }
      const member = await tx.user.findFirst({
        where: { id: userId, role: 'USER' },
        select: { id: true },
      });
      if (!member) throw AppError.notFound('User');

      const before = await tx.attendance.findUnique({
        where: { trainingId_userId: { trainingId, userId } },
      });
      const attendance = await tx.attendance.upsert({
        where: { trainingId_userId: { trainingId, userId } },
        create: {
          trainingId,
          userId,
          status: input.status,
          markedById: adminId,
          markedAt: this.now(),
        },
        update: { status: input.status, markedById: adminId, markedAt: this.now() },
      });
      const active = await tx.trainingCharge.findFirst({
        where: { trainingId, userId, status: 'ACTIVE' },
      });

      let reversal: LedgerResult | null = null;
      let charge: LedgerResult | null = null;
      if (input.status !== 'PRESENT' && active) {
        reversal = await this.ledger.reverseTrainingCharge(
          tx,
          { chargeId: active.id, reason: input.reason, adminId },
          ctx,
        );
      } else if (input.status === 'PRESENT' && !active) {
        const price = (await pricesFor(tx, training, [userId])).get(userId)!;
        ({ result: charge } = await this.ledger.chargeTraining(
          tx,
          {
            trainingId,
            trainingTitle: training.title,
            userId,
            attendanceId: attendance.id,
            unitPriceMinor: price.priceMinor,
            priceSource: price.source,
            currency: training.currency,
          },
          ctx,
        ));
      }
      await emitRealtime(tx, trainingChanged(trainingId));
      await writeAudit(tx, ctx, {
        action: 'attendance.corrected',
        entityType: 'Attendance',
        entityId: attendance.id,
        before: { userId, status: before?.status ?? null },
        after: {
          userId,
          status: input.status,
          reason: input.reason,
          reversed: active !== null && input.status !== 'PRESENT',
          charged: charge !== null,
        },
      });
      const row = (await this.list(trainingId, tx)).find((r) => r.user.id === userId)!;
      return { attendance: row, reversal, charge };
    });
  }

  /** Past trainings still waiting for finalization, oldest first. */
  async queue() {
    const now = this.now();
    const trainings = await this.prisma.training.findMany({
      where: {
        deletedAt: null,
        status: 'SCHEDULED',
        attendanceFinalizedAt: null,
        endsAt: { lt: now },
      },
      orderBy: { endsAt: 'asc' },
      take: 200,
    });
    const ids = trainings.map((t) => t.id);
    const [counts, present, pendingRows, unmarked] = await Promise.all([
      attendingCounts(this.prisma, ids),
      this.prisma.attendance.groupBy({
        by: ['trainingId'],
        where: { trainingId: { in: ids }, status: 'PRESENT' },
        _count: { _all: true },
      }),
      this.prisma.attendance.groupBy({
        by: ['trainingId'],
        where: { trainingId: { in: ids }, status: 'PENDING' },
        _count: { _all: true },
      }),
      ids.length === 0
        ? Promise.resolve([] as { id: string; n: number }[])
        : this.prisma.$queryRaw<{ id: string; n: number }[]>`
            SELECT r.training_id::text AS id, COUNT(*)::int AS n FROM training_reservations r
             WHERE r.training_id = ANY(${ids}::uuid[]) AND r.status = 'ATTENDING'
               AND NOT EXISTS (SELECT 1 FROM attendances a WHERE a.training_id = r.training_id AND a.user_id = r.user_id)
             GROUP BY r.training_id`,
    ]);
    return trainings.map((t) => ({
      training: toTraining(t, counts.get(t.id) ?? 0, now),
      pending:
        (pendingRows.find((p) => p.trainingId === t.id)?._count._all ?? 0) +
        (unmarked.find((u) => u.id === t.id)?.n ?? 0),
      present: present.find((p) => p.trainingId === t.id)?._count._all ?? 0,
      hoursSinceEnd: Math.floor((now.getTime() - t.endsAt.getTime()) / 3_600_000),
    }));
  }

  /** Worker job (D13): one reminder per admin per training, never an automatic finalization. */
  async remindUnfinalized(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - FINALIZE_REMINDER_HOURS * 3_600_000);
    const trainings = await this.prisma.training.findMany({
      where: {
        deletedAt: null,
        status: 'SCHEDULED',
        attendanceFinalizedAt: null,
        endsAt: { lt: cutoff },
      },
      select: { id: true, title: true, startsAt: true },
    });
    if (trainings.length === 0) return 0;
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    for (const t of trainings) {
      await notifyUsersNow(this.prisma, {
        userIds: admins.map((a) => a.id),
        type: 'ATTENDANCE_FINALIZATION_REMINDER',
        category: 'REMINDERS',
        params: { trainingId: t.id, title: t.title, startsAt: t.startsAt.toISOString() },
        dedupeKey: `finalize-reminder:${t.id}`,
      });
    }
    return trainings.length;
  }

  private assertStarted(training: { startsAt: Date }): void {
    if (this.now() < training.startsAt) {
      throw new AppError(
        'TRAINING_NOT_STARTED',
        'Attendance can be recorded once the training has started',
      );
    }
  }
}

export type { Tx };
