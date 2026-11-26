import type { Person, PriceSource, Training as TrainingDto } from '@tw/contracts';
import type { Db, Prisma } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { Training, TrainingCharge } from '../../generated/prisma/client';
import { notifyUsers } from '../notifications/notify';
import { currencyOf, money } from '../wallets/mappers';
import { resolvePrice } from './domain/pricing';

export type Tx = Prisma.TransactionClient;

/** Locks the training row for the rest of the transaction (capacity, finalization, cancel). */
export async function lockTraining(tx: Tx, trainingId: string): Promise<Training> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM trainings WHERE id = ${trainingId}::uuid AND deleted_at IS NULL FOR UPDATE`;
  if (rows.length === 0) throw AppError.notFound('Training');
  return tx.training.findUniqueOrThrow({ where: { id: trainingId } });
}

export async function findTraining(db: Db, trainingId: string): Promise<Training> {
  const training = await db.training.findFirst({ where: { id: trainingId, deletedAt: null } });
  if (!training) throw AppError.notFound('Training');
  return training;
}

export function assertNotCancelled(training: Training): void {
  if (training.status === 'CANCELLED') {
    throw new AppError('TRAINING_CANCELLED', 'This training has been cancelled');
  }
}

export function assertNotFinalized(training: Training): void {
  if (training.attendanceFinalizedAt) {
    throw new AppError('ATTENDANCE_FINALIZED', 'Attendance for this training is already finalized');
  }
}

export async function attendingCounts(db: Db, trainingIds: string[]): Promise<Map<string, number>> {
  if (trainingIds.length === 0) return new Map();
  const rows = await db.trainingReservation.groupBy({
    by: ['trainingId'],
    where: { trainingId: { in: trainingIds }, status: 'ATTENDING' },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.trainingId, r._count._all]));
}

export function toTraining(training: Training, attending: number, now: Date): TrainingDto {
  const currency = currencyOf(training.currency);
  return {
    id: training.id,
    seriesId: training.seriesId,
    title: training.title,
    description: training.description,
    location: training.location,
    startsAt: training.startsAt.toISOString(),
    endsAt: training.endsAt.toISOString(),
    timezone: training.timezone,
    capacity: training.capacity,
    attendingCount: attending,
    spotsLeft: training.capacity === null ? null : Math.max(0, training.capacity - attending),
    defaultPrice: money(training.defaultPriceMinor, currency),
    reservationDeadline: training.reservationDeadline.toISOString(),
    deadlinePassed: now >= training.reservationDeadline,
    status: training.status,
    cancelledAt: training.cancelledAt?.toISOString() ?? null,
    cancellationReason: training.cancellationReason,
    finalizedAt: training.attendanceFinalizedAt?.toISOString() ?? null,
  };
}

export function toChargeSummary(charge: TrainingCharge) {
  const currency = currencyOf(charge.currency);
  return {
    id: charge.id,
    status: charge.status,
    unitPrice: money(charge.unitPriceMinor, currency),
    priceSource: charge.priceSource,
    paidFromWallet: money(charge.paidFromWalletMinor, currency),
    shortfall: money(charge.shortfallMinor, currency),
    createdAt: charge.createdAt.toISOString(),
  };
}

export const PERSON_SELECT = {
  id: true,
  email: true,
  profile: { select: { firstName: true, lastName: true } },
} as const;

export function toPerson(user: {
  id: string;
  email: string;
  profile: { firstName: string; lastName: string } | null;
}): Person {
  return {
    id: user.id,
    email: user.email,
    firstName: user.profile?.firstName ?? '',
    lastName: user.profile?.lastName ?? '',
  };
}

export function byName(a: Person, b: Person): number {
  return (
    a.lastName.localeCompare(b.lastName) ||
    a.firstName.localeCompare(b.firstName) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Members relevant to one training: every active member, plus anyone (even inactive) who
 * responded, has an attendance row or was charged.
 */
export async function trainingPeople(db: Db, trainingId: string): Promise<Person[]> {
  const users = await db.user.findMany({
    where: {
      role: 'USER',
      deletedAt: null,
      OR: [
        { status: 'ACTIVE' },
        { reservations: { some: { trainingId } } },
        { attendances: { some: { trainingId } } },
        { trainingCharges: { some: { trainingId } } },
      ],
    },
    select: PERSON_SELECT,
  });
  return users.map(toPerson).sort(byName);
}

/** The resolved price (D5) of one training for each of `userIds`. */
export async function pricesFor(
  db: Db,
  training: Pick<Training, 'id' | 'defaultPriceMinor'>,
  userIds: string[],
): Promise<Map<string, { priceMinor: number; source: PriceSource }>> {
  const [overrides, standing] = await Promise.all([
    db.trainingPriceOverride.findMany({
      where: { trainingId: training.id, userId: { in: userIds } },
    }),
    db.userStandingPrice.findMany({ where: { userId: { in: userIds } } }),
  ]);
  const overrideBy = new Map(overrides.map((o) => [o.userId, o.priceMinor]));
  const standingBy = new Map(standing.map((s) => [s.userId, s.priceMinor]));
  return new Map(
    userIds.map((userId) => [
      userId,
      resolvePrice({
        defaultPriceMinor: training.defaultPriceMinor,
        standingPriceMinor: standingBy.get(userId),
        overridePriceMinor: overrideBy.get(userId),
      }),
    ]),
  );
}

/** In-app notifications (push delivery arrives in Phase 8). One per user and dedupe key. */
/** Re-exported so training code keeps one import; see notifications/notify.ts. */
export { notifyUsers };

export async function attendingUserIds(db: Db, trainingId: string): Promise<string[]> {
  const rows = await db.trainingReservation.findMany({
    where: { trainingId, status: 'ATTENDING' },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Opaque cursor for (startsAt, id) ordered training feeds. */
export function encodeTrainingCursor(training: { startsAt: Date; id: string }): string {
  return Buffer.from(`${training.startsAt.toISOString()}|${training.id}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeTrainingCursor(cursor: string): { startsAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const startsAt = new Date(iso ?? '');
  if (!id || Number.isNaN(startsAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw AppError.validation({ cursor: 'invalid' }, 'Invalid cursor');
  }
  return { startsAt, id };
}

/** Fields that change when or where a session happens: attendees are told (TRAINING_UPDATED). */
const SCHEDULE_FIELDS = ['startsAt', 'endsAt', 'location', 'timezone'] as const;

/**
 * D6: attendees hear about schedule changes; a price change only reaches the attendees whose
 * resolved price actually changed. Pass the attendees' prices from before the change.
 */
export async function notifyTrainingChanges(
  tx: Tx,
  before: Training,
  after: Training,
  pricesBefore: Map<string, { priceMinor: number }> | null,
): Promise<void> {
  const attendees = await attendingUserIds(tx, after.id);
  if (attendees.length === 0) return;
  const scheduleChanges = SCHEDULE_FIELDS.filter((f) => String(before[f]) !== String(after[f]));
  const pricesAfter = pricesBefore ? await pricesFor(tx, after, attendees) : null;
  const stamp = after.updatedAt.getTime();
  for (const userId of attendees) {
    const oldPrice = pricesBefore?.get(userId)?.priceMinor;
    const newPrice = pricesAfter?.get(userId)?.priceMinor;
    const priceChanged = oldPrice !== undefined && newPrice !== undefined && oldPrice !== newPrice;
    if (scheduleChanges.length === 0 && !priceChanged) continue;
    await notifyUsers(tx, {
      userIds: [userId],
      type: 'TRAINING_UPDATED',
      category: 'TRAININGS',
      params: {
        trainingId: after.id,
        title: after.title,
        startsAt: after.startsAt.toISOString(),
        changes: [...scheduleChanges, ...(priceChanged ? ['price'] : [])],
        ...(priceChanged ? { price: money(newPrice, after.currency) } : {}),
      },
      dedupeKey: `training-updated:${after.id}:${stamp}`,
    });
  }
}

/** A partial update where every field may also be explicitly undefined (validated PATCH bodies). */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };
