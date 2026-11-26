import type { TrainingSeries as TrainingSeriesDto } from '@tw/contracts';
import { writeAudit } from '../../core/audit/audit';
import type { AuditContext } from '../../core/context/request-context';
import type { Db, PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { Training, TrainingSeries } from '../../generated/prisma/client';
import { money } from '../wallets/mappers';
import {
  addDays,
  isValidTimeZone,
  localDate,
  parseRRule,
  toRRule,
  type Weekday,
  weeklyOccurrences,
  zonedTimeToUtc,
} from './domain/schedule';
import {
  attendingUserIds,
  notifyTrainingChanges,
  notifyUsers,
  pricesFor,
  type Patch,
  type Tx,
} from './training-support';
import { requireAdmin } from './trainings.service';
import { emitRealtime, trainingChanged } from '../realtime/realtime';

/** Sessions are generated this far ahead; the nightly job keeps the window rolling. */
export const SERIES_HORIZON_DAYS = 84;

export interface CreateSeriesInput {
  title: string;
  description?: string | undefined;
  location: string;
  weekdays: Weekday[];
  intervalWeeks: number;
  startTimeLocal: string;
  durationMinutes: number;
  timezone: string;
  capacity?: number | null | undefined;
  defaultPriceMinor: number;
  deadlineOffsetMinutes: number;
  startsOn: string;
  endsOn?: string | undefined;
}

export type UpdateSeriesInput = Patch<{
  title: string;
  description: string | null;
  location: string;
  capacity: number | null;
  defaultPriceMinor: number;
  endsOn: string | null;
}>;

interface ChangeCounts {
  updatedSessions: number;
  createdSessions: number;
  removedSessions: number;
  cancelledSessions: number;
}

const dateOf = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (d: string) => new Date(`${d}T00:00:00Z`);

/** D7: a series generates individual sessions; each session can then be edited on its own. */
export class SeriesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    input: CreateSeriesInput,
    ctx: AuditContext,
  ): Promise<{ series: TrainingSeriesDto } & ChangeCounts> {
    const adminId = requireAdmin(ctx);
    if (!isValidTimeZone(input.timezone))
      throw AppError.validation({ timezone: 'invalid' }, 'Unknown timezone');
    if (input.endsOn && input.endsOn > addDays(input.startsOn, 2 * 366)) {
      throw AppError.validation({ endsOn: 'too_far' }, 'A series can span at most two years');
    }
    const { series, created } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.trainingSeries.create({
        data: {
          title: input.title,
          description: input.description ?? null,
          location: input.location,
          rrule: toRRule({ weekdays: input.weekdays, intervalWeeks: input.intervalWeeks }),
          startTimeLocal: input.startTimeLocal,
          durationMinutes: input.durationMinutes,
          timezone: input.timezone,
          capacity: input.capacity ?? null,
          defaultPriceMinor: input.defaultPriceMinor,
          deadlineOffsetMin: input.deadlineOffsetMinutes,
          startsOn: dbDate(input.startsOn),
          endsOn: input.endsOn ? dbDate(input.endsOn) : null,
          createdById: adminId,
        },
      });
      const created = await this.generate(tx, row);
      await emitRealtime(tx, trainingChanged(null));
      await writeAudit(tx, ctx, {
        action: 'series.created',
        entityType: 'TrainingSeries',
        entityId: row.id,
        after: { ...row, created },
      });
      const members = await tx.user.findMany({
        where: { role: 'USER', status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      });
      await notifyUsers(tx, {
        userIds: members.map((m) => m.id),
        type: 'TRAINING_CREATED',
        category: 'TRAININGS',
        params: { seriesId: row.id, title: row.title, sessions: created },
        dedupeKey: `series-created:${row.id}`,
      });
      return { series: row, created };
    });
    return {
      series: await this.toDto(series),
      updatedSessions: 0,
      createdSessions: created,
      removedSessions: 0,
      cancelledSessions: 0,
    };
  }

  async list(): Promise<TrainingSeriesDto[]> {
    const rows = await this.prisma.trainingSeries.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((r) => this.toDto(r)));
  }

  async get(seriesId: string): Promise<TrainingSeriesDto> {
    const row = await this.prisma.trainingSeries.findFirst({
      where: { id: seriesId, deletedAt: null },
    });
    if (!row) throw AppError.notFound('Series');
    return this.toDto(row);
  }

  /**
   * Changes the series and its future sessions that are still scheduled. Shortening `endsOn`
   * removes untouched future sessions and cancels those members already responded to.
   */
  async update(
    seriesId: string,
    input: UpdateSeriesInput,
    ctx: AuditContext,
  ): Promise<{ series: TrainingSeriesDto } & ChangeCounts> {
    const { series, counts } = await this.prisma.$transaction(async (tx) => {
      const before = await this.lockSeries(tx, seriesId);
      const series = await tx.trainingSeries.update({
        where: { id: seriesId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          ...(input.defaultPriceMinor !== undefined
            ? { defaultPriceMinor: input.defaultPriceMinor }
            : {}),
          ...(input.endsOn !== undefined
            ? { endsOn: input.endsOn === null ? null : dbDate(input.endsOn) }
            : {}),
        },
      });
      const counts: ChangeCounts = {
        updatedSessions: 0,
        createdSessions: 0,
        removedSessions: 0,
        cancelledSessions: 0,
      };

      const sessionFields = {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.defaultPriceMinor !== undefined
          ? { defaultPriceMinor: input.defaultPriceMinor }
          : {}),
      };
      if (Object.keys(sessionFields).length > 0) {
        for (const session of await this.futureSessions(tx, seriesId)) {
          const pricesBefore =
            input.defaultPriceMinor === undefined
              ? null
              : await pricesFor(tx, session, await attendingUserIds(tx, session.id));
          const after = await tx.training.update({
            where: { id: session.id },
            data: sessionFields,
          });
          await notifyTrainingChanges(tx, session, after, pricesBefore);
          counts.updatedSessions += 1;
        }
      }
      if (input.endsOn) {
        const beyond = (await this.futureSessions(tx, seriesId)).filter(
          (s) => localDate(s.startsAt, series.timezone) > input.endsOn!,
        );
        Object.assign(
          counts,
          await this.withdraw(tx, beyond, 'The series ends earlier', ctx, counts),
        );
      }
      counts.createdSessions = await this.generate(tx, series);
      await emitRealtime(tx, trainingChanged(null));
      await writeAudit(tx, ctx, {
        action: 'series.updated',
        entityType: 'TrainingSeries',
        entityId: seriesId,
        before,
        after: { ...series, ...counts },
      });
      return { series, counts };
    });
    return { series: await this.toDto(series), ...counts };
  }

  /** Ends the series today: past sessions stay, future ones are removed or cancelled. */
  async remove(seriesId: string, ctx: AuditContext): Promise<ChangeCounts> {
    return this.prisma.$transaction(async (tx) => {
      const series = await this.lockSeries(tx, seriesId);
      const today = localDate(this.now(), series.timezone);
      await tx.trainingSeries.update({
        where: { id: seriesId },
        data: { deletedAt: this.now(), endsOn: dbDate(today) },
      });
      const counts = await this.withdraw(
        tx,
        await this.futureSessions(tx, seriesId),
        'The series has ended',
        ctx,
        {
          updatedSessions: 0,
          createdSessions: 0,
          removedSessions: 0,
          cancelledSessions: 0,
        },
      );
      await emitRealtime(tx, trainingChanged(null));
      await writeAudit(tx, ctx, {
        action: 'series.deleted',
        entityType: 'TrainingSeries',
        entityId: seriesId,
        before: series,
        after: counts,
      });
      return counts;
    });
  }

  /** Worker job: keeps every open series generated up to the horizon. */
  async extendAll(): Promise<number> {
    const series = await this.prisma.trainingSeries.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    let created = 0;
    for (const { id } of series) {
      created += await this.prisma.$transaction(async (tx) =>
        this.generate(tx, await this.lockSeries(tx, id)),
      );
    }
    return created;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Creates the sessions from the day after the last generated one (deleted ones count, so a
   * removed session is never re-created) up to the horizon or `endsOn`. Never in the past.
   * The partial unique index (series, start) makes double generation impossible.
   */
  private async generate(tx: Tx, series: TrainingSeries): Promise<number> {
    const now = this.now();
    const today = localDate(now, series.timezone);
    const horizon = addDays(today, SERIES_HORIZON_DAYS);
    const endsOn = series.endsOn ? dateOf(series.endsOn) : null;
    const until = endsOn && endsOn < horizon ? endsOn : horizon;
    const last = await tx.training.findFirst({
      where: { seriesId: series.id },
      orderBy: { startsAt: 'desc' },
      select: { startsAt: true },
    });
    const startsOn = dateOf(series.startsOn);
    const nextDay = last ? addDays(localDate(last.startsAt, series.timezone), 1) : startsOn;
    const from = nextDay > startsOn ? nextDay : startsOn;

    const data = weeklyOccurrences(parseRRule(series.rrule), from, until)
      .map((date) => zonedTimeToUtc(date, series.startTimeLocal, series.timezone))
      .filter((startsAt) => startsAt > now)
      .map((startsAt) => ({
        seriesId: series.id,
        title: series.title,
        description: series.description,
        location: series.location,
        startsAt,
        endsAt: new Date(startsAt.getTime() + series.durationMinutes * 60_000),
        timezone: series.timezone,
        capacity: series.capacity,
        defaultPriceMinor: series.defaultPriceMinor,
        currency: series.currency,
        reservationDeadline: new Date(startsAt.getTime() - series.deadlineOffsetMin * 60_000),
        createdById: series.createdById,
      }));
    if (data.length === 0) return 0;
    const result = await tx.training.createMany({ data, skipDuplicates: true });
    return result.count;
  }

  private futureSessions(tx: Tx, seriesId: string): Promise<Training[]> {
    return tx.training.findMany({
      where: { seriesId, deletedAt: null, status: 'SCHEDULED', startsAt: { gt: this.now() } },
      orderBy: { startsAt: 'asc' },
    });
  }

  /** Untouched sessions are deleted; sessions with responses are cancelled and attendees told. */
  private async withdraw(
    tx: Tx,
    sessions: Training[],
    reason: string,
    ctx: AuditContext,
    counts: ChangeCounts,
  ): Promise<ChangeCounts> {
    const now = this.now();
    for (const session of sessions) {
      const touched =
        (await tx.trainingReservation.count({ where: { trainingId: session.id } })) +
        (await tx.attendance.count({ where: { trainingId: session.id } }));
      if (touched === 0) {
        await tx.training.update({ where: { id: session.id }, data: { deletedAt: now } });
        counts.removedSessions += 1;
        continue;
      }
      await tx.training.update({
        where: { id: session.id },
        data: { status: 'CANCELLED', cancelledAt: now, cancellationReason: reason },
      });
      await writeAudit(tx, ctx, {
        action: 'training.cancelled',
        entityType: 'Training',
        entityId: session.id,
        after: { reason, bySeries: true },
      });
      await notifyUsers(tx, {
        userIds: await attendingUserIds(tx, session.id),
        type: 'TRAINING_CANCELLED',
        category: 'TRAININGS',
        params: {
          trainingId: session.id,
          title: session.title,
          startsAt: session.startsAt.toISOString(),
          reason,
          refunded: false,
        },
        dedupeKey: `training-cancelled:${session.id}`,
      });
      counts.cancelledSessions += 1;
    }
    return counts;
  }

  private async lockSeries(tx: Tx, seriesId: string): Promise<TrainingSeries> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM training_series WHERE id = ${seriesId}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (rows.length === 0) throw AppError.notFound('Series');
    return tx.trainingSeries.findUniqueOrThrow({ where: { id: seriesId } });
  }

  private async toDto(series: TrainingSeries, db: Db = this.prisma): Promise<TrainingSeriesDto> {
    const rule = parseRRule(series.rrule);
    const upcomingCount = await db.training.count({
      where: {
        seriesId: series.id,
        deletedAt: null,
        status: 'SCHEDULED',
        startsAt: { gt: this.now() },
      },
    });
    return {
      id: series.id,
      title: series.title,
      description: series.description,
      location: series.location,
      rrule: series.rrule,
      weekdays: rule.weekdays,
      intervalWeeks: rule.intervalWeeks,
      startTimeLocal: series.startTimeLocal,
      durationMinutes: series.durationMinutes,
      timezone: series.timezone,
      capacity: series.capacity,
      defaultPrice: money(series.defaultPriceMinor, series.currency),
      deadlineOffsetMinutes: series.deadlineOffsetMin,
      startsOn: dateOf(series.startsOn),
      endsOn: series.endsOn ? dateOf(series.endsOn) : null,
      upcomingCount,
      createdAt: series.createdAt.toISOString(),
    };
  }
}
