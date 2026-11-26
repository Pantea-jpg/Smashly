import type { NotificationCategory, NotificationType } from '@tw/contracts';
import type { Prisma, PrismaClient } from '../../core/db/prisma';
import { enqueueOutbox } from '../../core/outbox/outbox';
import { emitRealtime, rooms } from '../realtime/realtime';

export interface NotifyInput {
  userIds: readonly string[];
  type: NotificationType;
  category: NotificationCategory;
  /** Language-neutral; rendered by the app and the push sender from `notifications:types.*`. */
  params: Record<string, unknown>;
  /** Unique per user: notifying twice with the same key creates (and pushes) nothing. */
  dedupeKey: string;
}

/** One outbox event per this many notifications (a training announced to every member). */
const PUSH_BATCH_SIZE = 100;

/**
 * The single way to notify users. In the caller's transaction it:
 *   1. inserts the in-app notifications, skipping any whose (user, dedupeKey) already exists;
 *   2. queues push delivery (outbox) for the rows actually created;
 *   3. emits `notification.created` to each recipient's socket (on commit).
 * Always runs inside the caller's (business) transaction, so nothing is announced for a change
 * that rolls back. Returns the ids of the notifications created.
 */
export async function notifyUsers(
  tx: Prisma.TransactionClient,
  input: NotifyInput,
): Promise<string[]> {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) return [];
  const created = await tx.notification.createManyAndReturn({
    data: userIds.map((userId) => ({
      userId,
      type: input.type,
      category: input.category,
      params: input.params as Prisma.InputJsonValue,
      dedupeKey: input.dedupeKey,
    })),
    skipDuplicates: true,
    select: { id: true, userId: true },
  });
  if (created.length === 0) return [];

  for (let i = 0; i < created.length; i += PUSH_BATCH_SIZE) {
    await enqueueOutbox(tx, 'notification.push', {
      notificationIds: created.slice(i, i + PUSH_BATCH_SIZE).map((n) => n.id),
    });
  }
  await emitRealtime(
    tx,
    created.map((n) => ({
      room: rooms.user(n.userId),
      event: 'notification.created' as const,
      data: { notificationId: n.id },
    })),
  );
  return created.map((n) => n.id);
}

/** For jobs with no business transaction of their own: notifies in a short transaction. */
export function notifyUsersNow(prisma: PrismaClient, input: NotifyInput): Promise<string[]> {
  if (input.userIds.length === 0) return Promise.resolve([]);
  return prisma.$transaction((tx) => notifyUsers(tx, input));
}
