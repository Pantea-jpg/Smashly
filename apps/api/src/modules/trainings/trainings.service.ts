import type {
  AdminTraining,
  MeTraining,
  ReservationStatus,
  TrainingHistoryItem,
  TrainingStatus,
} from '@tw/contracts';
import { writeAudit } from '../../core/audit/audit';
import type { AuditContext } from '../../core/context/request-context';
import type { Db, Prisma, PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { Training } from '../../generated/prisma/client';
import type { SettingsService } from '../admin/settings.service';
import type { LedgerService } from '../wallets/ledger.service';
import { currencyOf, money } from '../wallets/mappers';
import { isValidTimeZone } from './domain/schedule';
import {
  assertNotCancelled,
  assertNotFinalized,
  attendingCounts,
  attendingUserIds,
  decodeTrainingCursor,
  encodeTrainingCursor,
  findTraining,
  lockTraining,
  notifyTrainingChanges,
  notifyUsers,
  pricesFor,
  toChargeSummary,
  toTraining,
  trainingPeople,
  type Patch,
  type Tx,
} from './training-support';
import { emitRealtime, rooms, trainingChanged } from '../realtime/realtime';

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export interface CreateTrainingInput {
  title: string;
  description?: string | undefined;
  location: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  capacity?: number | null | undefined;
  defaultPriceMinor: number;
  reservationDeadline?: string | undefined;
}

export type UpdateTrainingInput = Patch<{
  title: string;
  description: string | null;
  location: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  capacity: number | null;
  defaultPriceMinor: number;
  reservationDeadline: string;
}>;

/** Fields that cannot change once attendance is finalized and charges exist. */
const LOCKED_AFTER_FINALIZATION = [
  'startsAt',
  'endsAt',
  'timezone',
  'capacity',
  'defaultPriceMinor',
  'reservationDeadline',
] as const;

export class TrainingsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Admin: CRUD ──────────────────────────────────────────────────────────

  async create(input: CreateTrainingInput, ctx: AuditContext): Promise<AdminTraining> {
    assertTimeZone(input.timezone);
    const adminId = requireAdmin(ctx);
    const training = await this.prisma.$transaction(async (tx) => {
      const created = await tx.training.create({
        data: {
          title: input.title,
          description: input.description ?? null,
          location: input.location,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          timezone: input.timezone,
          capacity: input.capacity ?? null,
          defaultPriceMinor: input.defaultPriceMinor,
          reservationDeadline: new Date(input.reservationDeadline ?? input.startsAt),
          createdById: adminId,
        },
      });
      await writeAudit(tx, ctx, {
        action: 'training.created',
        entityType: 'Training',
        entityId: created.id,
        after: created,
      });
      const members = await tx.user.findMany({
        where: { role: 'USER', status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      });
      await notifyUsers(tx, {
        userIds: members.map((m) => m.id),
        type: 'TRAINING_CREATED',
        category: 'TRAININGS',
        params: {
          trainingId: created.id,
          title: created.title,
          startsAt: created.startsAt.toISOString(),
        },
        dedupeKey: `training-created:${created.id}`,
      });
      await emitRealtime(tx, trainingChanged(created.id));
      return created;
    });
    return this.adminTraining(training);
  }

  async update(
    trainingId: string,
    input: UpdateTrainingInput,
    ctx: AuditContext,
  ): Promise<AdminTraining> {
    if (input.timezone !== undefined) assertTimeZone(input.timezone);
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await lockTraining(tx, trainingId);
      assertNotCancelled(before);
      if (
        before.attendanceFinalizedAt &&
        LOCKED_AFTER_FINALIZATION.some((f) => input[f] !== undefined)
      ) {
        throw new AppError(
          'ATTENDANCE_FINALIZED',
          'Only title, description and location can change after finalization',
        );
      }
      const startsAt = input.startsAt ? new Date(input.startsAt) : before.startsAt;
      const endsAt = input.endsAt ? new Date(input.endsAt) : before.endsAt;
      // Moving the start moves a deadline that was "until the start" along with it.
      const deadlineWasStart = before.reservationDeadline.getTime() === before.startsAt.getTime();
      const reservationDeadline = input.reservationDeadline
        ? new Date(input.reservationDeadline)
        : deadlineWasStart
          ? startsAt
          : before.reservationDeadline;
      if (endsAt <= startsAt)
        throw AppError.validation({ endsAt: 'must_be_after_start' }, 'End must be after start');
      if (reservationDeadline > startsAt) {
        throw AppError.validation(
          { reservationDeadline: 'must_not_be_after_start' },
          'Deadline must not be after the start',
        );
      }

      const pricesBefore =
        input.defaultPriceMinor === undefined
          ? null
          : await pricesFor(tx, before, await attendingUserIds(tx, trainingId));
      const after = await tx.training.update({
        where: { id: trainingId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          ...(input.defaultPriceMinor !== undefined
            ? { defaultPriceMinor: input.defaultPriceMinor }
            : {}),
          startsAt,
          endsAt,
          reservationDeadline,
        },
      });
      await writeAudit(tx, ctx, {
        action: 'training.updated',
        entityType: 'Training',
        entityId: trainingId,
        before,
        after,
      });
      await notifyTrainingChanges(tx, before, after, pricesBefore);
      await emitRealtime(tx, trainingChanged(trainingId));
      return after;
    });
    return this.adminTraining(updated);
  }

  /**
   * D12: cancelling a finalized training reverses every active charge (paid amounts go back to
   * the wallets, open debt is cancelled). Attendees and charged members are notified.
   */
  async cancel(
    trainingId: string,
    reason: string,
    ctx: AuditContext,
  ): Promise<{ training: AdminTraining; reversedCharges: number }> {
    const adminId = requireAdmin(ctx);
    const { training, reversed } = await this.ledger.run(undefined, async (tx) => {
      const before = await lockTraining(tx, trainingId);
      assertNotCancelled(before);
      const charges = await tx.trainingCharge.findMany({
        where: { trainingId, status: 'ACTIVE' },
        orderBy: { userId: 'asc' },
      });
      for (const charge of charges) {
        await this.ledger.reverseTrainingCharge(
          tx,
          { chargeId: charge.id, reason: `Training cancelled: ${reason}`, adminId },
          ctx,
        );
      }
      const after = await tx.training.update({
        where: { id: trainingId },
        data: { status: 'CANCELLED', cancelledAt: this.now(), cancellationReason: reason },
      });
      await writeAudit(tx, ctx, {
        action: 'training.cancelled',
        entityType: 'Training',
        entityId: trainingId,
        before: { status: before.status },
        after: { status: 'CANCELLED', reason, reversedCharges: charges.length },
      });
      await notifyUsers(tx, {
        userIds: [...(await attendingUserIds(tx, trainingId)), ...charges.map((c) => c.userId)],
        type: 'TRAINING_CANCELLED',
        category: 'TRAININGS',
        params: {
          trainingId,
          title: after.title,
          startsAt: after.startsAt.toISOString(),
          reason,
          refunded: charges.length > 0,
        },
        dedupeKey: `training-cancelled:${trainingId}`,
      });
      await emitRealtime(tx, trainingChanged(trainingId));
      return { training: after, reversed: charges.length };
    });
    return { training: await this.adminTraining(training), reversedCharges: reversed };
  }

  /** Only a training nobody interacted with can be deleted; otherwise cancel it. */
  async remove(trainingId: string, ctx: AuditContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const training = await lockTraining(tx, trainingId);
      const [reservations, attendances, charges] = await Promise.all([
        tx.trainingReservation.count({ where: { trainingId } }),
        tx.attendance.count({ where: { trainingId } }),
        tx.trainingCharge.count({ where: { trainingId } }),
      ]);
      if (reservations + attendances + charges > 0) {
        throw new AppError(
          'CONFLICT',
          'This training has reservations or attendance; cancel it instead',
        );
      }
      await tx.training.update({ where: { id: trainingId }, data: { deletedAt: this.now() } });
      await writeAudit(tx, ctx, {
        action: 'training.deleted',
        entityType: 'Training',
        entityId: trainingId,
        before: training,
      });
      await emitRealtime(tx, trainingChanged(trainingId));
    });
  }

  // ── Admin: queries ───────────────────────────────────────────────────────

  async listAdmin(query: {
    page: number;
    pageSize: number;
    from?: string | undefined;
    to?: string | undefined;
    status?: TrainingStatus | undefined;
    seriesId?: string | undefined;
  }): Promise<{ items: AdminTraining[]; page: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.TrainingWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.seriesId ? { seriesId: query.seriesId } : {}),
      ...(query.from || query.to
        ? {
            startsAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [total, trainings] = await Promise.all([
      this.prisma.training.count({ where }),
      this.prisma.training.findMany({
        where,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: await this.adminTrainings(trainings),
      page: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  async getAdmin(trainingId: string): Promise<AdminTraining> {
    return this.adminTraining(await findTraining(this.prisma, trainingId));
  }

  async adminTraining(training: Training, db: Db = this.prisma): Promise<AdminTraining> {
    const [item] = await this.adminTrainings([training], db);
    return item!;
  }

  async adminTrainings(trainings: Training[], db: Db = this.prisma): Promise<AdminTraining[]> {
    if (trainings.length === 0) return [];
    const ids = trainings.map((t) => t.id);
    const [reservations, activeResponders, attendance, unmarked, activeMembers] = await Promise.all(
      [
        db.trainingReservation.groupBy({
          by: ['trainingId', 'status'],
          where: { trainingId: { in: ids } },
          _count: { _all: true },
        }),
        db.trainingReservation.groupBy({
          by: ['trainingId'],
          where: { trainingId: { in: ids }, user: { status: 'ACTIVE', deletedAt: null } },
          _count: { _all: true },
        }),
        db.attendance.groupBy({
          by: ['trainingId', 'status'],
          where: { trainingId: { in: ids } },
          _count: { _all: true },
        }),
        db.$queryRaw<{ id: string; n: number }[]>`
        SELECT r.training_id::text AS id, COUNT(*)::int AS n
          FROM training_reservations r
         WHERE r.training_id = ANY(${ids}::uuid[]) AND r.status = 'ATTENDING'
           AND NOT EXISTS (SELECT 1 FROM attendances a WHERE a.training_id = r.training_id AND a.user_id = r.user_id)
         GROUP BY r.training_id`,
        db.user.count({ where: { role: 'USER', status: 'ACTIVE', deletedAt: null } }),
      ],
    );
    const count = (
      rows: { trainingId: string; status: string; _count: { _all: number } }[],
      id: string,
      status: string,
    ) => rows.find((r) => r.trainingId === id && r.status === status)?._count._all ?? 0;
    const now = this.now();
    return trainings.map((t) => {
      const attending = count(reservations, t.id, 'ATTENDING');
      const responded = activeResponders.find((r) => r.trainingId === t.id)?._count._all ?? 0;
      return {
        ...toTraining(t, attending, now),
        createdById: t.createdById,
        finalizedById: t.attendanceFinalizedById,
        counts: {
          attending,
          notAttending: count(reservations, t.id, 'NOT_ATTENDING'),
          noResponse: Math.max(0, activeMembers - responded),
          present: count(attendance, t.id, 'PRESENT'),
          absent: count(attendance, t.id, 'ABSENT'),
          excused: count(attendance, t.id, 'EXCUSED'),
          pending:
            count(attendance, t.id, 'PENDING') + (unmarked.find((u) => u.id === t.id)?.n ?? 0),
        },
      };
    });
  }

  // ── Reservations ─────────────────────────────────────────────────────────

  /**
   * A member's own response. Checks run under the training row lock, so concurrent requests
   * can never overfill a training. Re-sending the same status is a no-op (idempotent upsert).
   */
  async reserve(
    userId: string,
    trainingId: string,
    status: ReservationStatus,
  ): Promise<{ training: MeTraining; warning: 'OUTSTANDING_DEBT' | null }> {
    const debtMinor = await this.prisma.$transaction(async (tx) => {
      const training = await lockTraining(tx, trainingId);
      assertNotCancelled(training);
      assertNotFinalized(training);
      if (this.now() >= training.reservationDeadline) {
        throw new AppError('RESERVATION_DEADLINE_PASSED', 'The reservation deadline has passed');
      }
      const member = await tx.user.findUnique({
        where: { id: userId },
        select: {
          role: true,
          status: true,
          wallets: { where: { currency: training.currency }, select: { debtMinor: true } },
        },
      });
      if (member?.role !== 'USER') throw AppError.forbidden('Only members can reserve trainings');
      if (member.status !== 'ACTIVE')
        throw new AppError('ACCOUNT_INACTIVE', 'Account is not active');
      const debt = member.wallets[0]?.debtMinor ?? 0;
      if (status === 'ATTENDING') {
        const blockAbove = await this.settings.get('reservations.blockWhenDebtAboveMinor', tx);
        if (blockAbove !== null && debt > blockAbove) {
          throw new AppError(
            'RESERVATION_BLOCKED_BY_DEBT',
            'Outstanding debt is above the limit for reserving',
            {
              debt: money(debt, training.currency),
              limit: money(blockAbove, training.currency),
            },
          );
        }
        await this.assertCapacity(tx, training, userId);
      }
      await this.upsertReservation(tx, trainingId, userId, status, userId);
      return debt;
    });
    return {
      training: await this.meTraining(userId, trainingId),
      warning: status === 'ATTENDING' && debtMinor > 0 ? 'OUTSTANDING_DEBT' : null,
    };
  }

  /** An admin sets or overrides a member's response: after the deadline, and beyond capacity with `force`. */
  async setReservation(
    trainingId: string,
    userId: string,
    input: { status: ReservationStatus; force: boolean },
    ctx: AuditContext,
  ): Promise<void> {
    const adminId = requireAdmin(ctx);
    await this.prisma.$transaction(async (tx) => {
      const training = await lockTraining(tx, trainingId);
      assertNotCancelled(training);
      assertNotFinalized(training);
      const member = await tx.user.findFirst({
        where: { id: userId, role: 'USER', deletedAt: null },
        select: { id: true },
      });
      if (!member) throw AppError.notFound('User');
      if (input.status === 'ATTENDING' && !input.force)
        await this.assertCapacity(tx, training, userId);
      const before = await tx.trainingReservation.findUnique({
        where: { trainingId_userId: { trainingId, userId } },
      });
      await this.upsertReservation(tx, trainingId, userId, input.status, adminId);
      await writeAudit(tx, ctx, {
        action: 'reservation.set_by_admin',
        entityType: 'TrainingReservation',
        entityId: trainingId,
        before: before ? { userId, status: before.status } : { userId, status: null },
        after: { userId, status: input.status, force: input.force },
      });
      if (before?.status !== input.status) {
        await notifyUsers(tx, {
          userIds: [userId],
          type: 'RESERVATION_CONFIRMED',
          category: 'TRAININGS',
          params: {
            trainingId,
            title: training.title,
            startsAt: training.startsAt.toISOString(),
            status: input.status,
            byAdmin: true,
          },
          dedupeKey: `reservation:${trainingId}:${input.status}:${this.now().getTime()}`,
        });
      }
    });
  }

  /** Every relevant member with their response; a null status means no response yet. */
  async listReservations(trainingId: string) {
    await findTraining(this.prisma, trainingId);
    const [people, reservations] = await Promise.all([
      trainingPeople(this.prisma, trainingId),
      this.prisma.trainingReservation.findMany({ where: { trainingId } }),
    ]);
    return people.map((user) => {
      const r = reservations.find((x) => x.userId === user.id);
      return {
        user,
        status: r?.status ?? null,
        respondedAt: r?.respondedAt.toISOString() ?? null,
        respondedByAdmin: r ? r.respondedById !== user.id : false,
      };
    });
  }

  private async assertCapacity(tx: Tx, training: Training, userId: string): Promise<void> {
    if (training.capacity === null) return;
    const others = await tx.trainingReservation.count({
      where: { trainingId: training.id, status: 'ATTENDING', userId: { not: userId } },
    });
    if (others >= training.capacity) {
      throw new AppError('TRAINING_FULL', 'This training is full', { capacity: training.capacity });
    }
  }

  private async upsertReservation(
    tx: Tx,
    trainingId: string,
    userId: string,
    status: ReservationStatus,
    respondedById: string,
  ) {
    const now = this.now();
    await tx.trainingReservation.upsert({
      where: { trainingId_userId: { trainingId, userId } },
      create: { trainingId, userId, status, respondedById, respondedAt: now },
      update: { status, respondedById, respondedAt: now },
    });
    // Places left changed for everyone; the admin's response list for this training too.
    await emitRealtime(tx, [
      ...trainingChanged(trainingId),
      { room: rooms.admins, event: 'reservation.updated', data: { trainingId } },
    ]);
  }

  // ── Member views ─────────────────────────────────────────────────────────

  /**
   * upcoming: every training that has not ended (cancelled ones included, so members see it).
   * past: ended trainings the member responded to, attended or was charged for.
   * attended: trainings with an attendance record or charge for the member, at any time
   * (a training can be finalized before it ends).
   */
  async listMe(
    userId: string,
    query: { scope: 'upcoming' | 'past' | 'attended'; limit: number; cursor?: string | undefined },
  ): Promise<{ items: MeTraining[]; page: { nextCursor: string | null; hasMore: boolean } }> {
    const now = this.now();
    const upcoming = query.scope === 'upcoming';
    const after = query.cursor ? decodeTrainingCursor(query.cursor) : null;
    const scopeFilter: Prisma.TrainingWhereInput =
      query.scope === 'upcoming'
        ? { endsAt: { gte: now } }
        : query.scope === 'past'
          ? {
              endsAt: { lt: now },
              OR: [
                { reservations: { some: { userId } } },
                { attendances: { some: { userId } } },
                { charges: { some: { userId } } },
              ],
            }
          : { OR: [{ attendances: { some: { userId } } }, { charges: { some: { userId } } }] };
    const trainings = await this.prisma.training.findMany({
      where: {
        deletedAt: null,
        ...scopeFilter,
        ...(after
          ? {
              AND: [
                upcoming
                  ? {
                      OR: [
                        { startsAt: { gt: after.startsAt } },
                        { startsAt: after.startsAt, id: { gt: after.id } },
                      ],
                    }
                  : {
                      OR: [
                        { startsAt: { lt: after.startsAt } },
                        { startsAt: after.startsAt, id: { lt: after.id } },
                      ],
                    },
              ],
            }
          : {}),
      },
      orderBy: upcoming
        ? [{ startsAt: 'asc' }, { id: 'asc' }]
        : [{ startsAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const hasMore = trainings.length > query.limit;
    const page = trainings.slice(0, query.limit);
    return {
      items: await this.meTrainings(userId, page),
      page: { nextCursor: hasMore ? encodeTrainingCursor(page[page.length - 1]!) : null, hasMore },
    };
  }

  async meTraining(userId: string, trainingId: string): Promise<MeTraining> {
    const [item] = await this.meTrainings(userId, [await findTraining(this.prisma, trainingId)]);
    return item!;
  }

  private async meTrainings(userId: string, trainings: Training[]): Promise<MeTraining[]> {
    if (trainings.length === 0) return [];
    const ids = trainings.map((t) => t.id);
    const [counts, reservations, attendances, charges, overrides, standing] = await Promise.all([
      attendingCounts(this.prisma, ids),
      this.prisma.trainingReservation.findMany({ where: { userId, trainingId: { in: ids } } }),
      this.prisma.attendance.findMany({ where: { userId, trainingId: { in: ids } } }),
      this.prisma.trainingCharge.findMany({
        where: { userId, trainingId: { in: ids } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.trainingPriceOverride.findMany({ where: { userId, trainingId: { in: ids } } }),
      this.prisma.userStandingPrice.findUnique({ where: { userId } }),
    ]);
    const now = this.now();
    return trainings.map((t) => {
      const override = overrides.find((o) => o.trainingId === t.id)?.priceMinor;
      const forTraining = charges.filter((c) => c.trainingId === t.id);
      const charge = forTraining.find((c) => c.status === 'ACTIVE') ?? forTraining[0] ?? null;
      const price =
        override !== undefined
          ? { priceMinor: override, source: 'TRAINING_OVERRIDE' as const }
          : standing
            ? { priceMinor: standing.priceMinor, source: 'USER_STANDING_PRICE' as const }
            : { priceMinor: t.defaultPriceMinor, source: 'TRAINING_DEFAULT' as const };
      return {
        ...toTraining(t, counts.get(t.id) ?? 0, now),
        myPrice: { price: money(price.priceMinor, currencyOf(t.currency)), source: price.source },
        myReservation: reservations.find((r) => r.trainingId === t.id)?.status ?? null,
        myAttendance: attendances.find((a) => a.trainingId === t.id)?.status ?? null,
        myCharge: charge ? toChargeSummary(charge) : null,
      };
    });
  }

  /** One member's trainings with response, attendance and charge, newest first. */
  async history(
    userId: string,
    query: { page: number; pageSize: number },
  ): Promise<{
    items: TrainingHistoryItem[];
    page: { page: number; pageSize: number; total: number };
  }> {
    const where: Prisma.TrainingWhereInput = {
      deletedAt: null,
      OR: [
        { reservations: { some: { userId } } },
        { attendances: { some: { userId } } },
        { charges: { some: { userId } } },
      ],
    };
    const [total, trainings] = await Promise.all([
      this.prisma.training.count({ where }),
      this.prisma.training.findMany({
        where,
        orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    const items = (await this.meTrainings(userId, trainings)).map((t) => ({
      training: stripMine(t),
      reservation: t.myReservation,
      attendance: t.myAttendance,
      charge: t.myCharge,
    }));
    return { items, page: { page: query.page, pageSize: query.pageSize, total } };
  }

  async meAttendance(
    userId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<{
    items: TrainingHistoryItem[];
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const { items, page } = await this.listMe(userId, { scope: 'attended', ...query });
    return {
      items: items.map((t) => ({
        training: stripMine(t),
        reservation: t.myReservation,
        attendance: t.myAttendance,
        charge: t.myCharge,
      })),
      page,
    };
  }
}

function stripMine(t: MeTraining) {
  const { myPrice: _p, myReservation: _r, myAttendance: _a, myCharge: _c, ...training } = t;
  return training;
}

function requireAdmin(ctx: AuditContext): string {
  if (ctx.actor?.role !== 'ADMIN') throw AppError.forbidden();
  return ctx.actor.id;
}

function assertTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone))
    throw AppError.validation({ timezone: 'invalid' }, 'Unknown timezone');
}

export { requireAdmin, TX_OPTIONS };
