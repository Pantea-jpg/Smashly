import type { RealtimeEventMap, RealtimeEventName } from '@tw/contracts';
import type { Db } from '../../core/db/prisma';

/** Postgres channel that carries realtime events from any process to every API instance. */
export const REALTIME_CHANNEL = 'tw_realtime';

export const rooms = {
  user: (userId: string) => `user:${userId}`,
  members: 'members',
  admins: 'admins',
} as const;

export type RealtimeMessage = {
  [K in RealtimeEventName]: { room: string; event: K; data: RealtimeEventMap[K] };
}[RealtimeEventName];

/** Postgres limits a NOTIFY payload to 8000 bytes; ids-only events are ~100 bytes each. */
const MESSAGES_PER_NOTIFY = 40;

/**
 * Publishes realtime events with `pg_notify`. Called with the business transaction, Postgres
 * delivers the notification only if that transaction COMMITS (and drops identical duplicates
 * within it), so clients never hear about a change that was rolled back. Every API instance
 * LISTENs on the channel and emits to its own sockets (see realtime.server.ts).
 */
export async function emitRealtime(
  db: Db,
  messages: RealtimeMessage | readonly RealtimeMessage[],
): Promise<void> {
  const list = Array.isArray(messages) ? messages : [messages as RealtimeMessage];
  for (let i = 0; i < list.length; i += MESSAGES_PER_NOTIFY) {
    const payload = JSON.stringify(list.slice(i, i + MESSAGES_PER_NOTIFY));
    await db.$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${payload})`;
  }
}

/**
 * Every member's training lists change (new, edited, cancelled, places left).
 * `null`: several trainings changed at once (a recurring series).
 */
export function trainingChanged(trainingId: string | null): RealtimeMessage[] {
  return [
    { room: rooms.members, event: 'training.updated', data: { trainingId } },
    { room: rooms.admins, event: 'training.updated', data: { trainingId } },
  ];
}

/** A wallet moved: the owner's money screens and the admin dashboards. */
export function walletChanged(userId: string): RealtimeMessage[] {
  return [
    { room: rooms.user(userId), event: 'wallet.updated', data: { userId } },
    { room: rooms.admins, event: 'admin.activity', data: { userId } },
  ];
}
