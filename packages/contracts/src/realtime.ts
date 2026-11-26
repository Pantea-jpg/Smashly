/**
 * Socket.IO events (server → client). Payloads carry ids only: the app treats every event
 * as "this data changed" and refetches over REST. Rooms: `user:<id>` (own events),
 * `members` (every signed-in user), `admins`.
 */
export const REALTIME_PATH = '/realtime';

export interface RealtimeEventMap {
  'wallet.updated': { userId: string };
  'payment.updated': { paymentId: string };
  'notification.created': { notificationId: string };
  /** null: several trainings changed (a recurring series); refetch the lists. */
  'training.updated': { trainingId: string | null };
  'reservation.updated': { trainingId: string };
  'admin.activity': { userId?: string };
}
export type RealtimeEventName = keyof RealtimeEventMap;

export const REALTIME_EVENTS = [
  'wallet.updated',
  'payment.updated',
  'notification.created',
  'training.updated',
  'reservation.updated',
  'admin.activity',
] as const satisfies readonly RealtimeEventName[];
