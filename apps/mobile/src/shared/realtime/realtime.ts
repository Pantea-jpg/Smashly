import type { QueryKey } from '@tanstack/react-query';
import { REALTIME_EVENTS, type RealtimeEventMap, type RealtimeEventName } from '@tw/contracts';

/**
 * Which cached queries a realtime event makes stale. Events carry ids only; data always
 * comes from REST (docs/04-api.md §3). Keys are prefixes, so ['subject', me, 'notifications']
 * also covers the unread count. Events only ever concern the signed-in account (`selfId`).
 */
export function invalidationsFor<E extends RealtimeEventName>(
  event: E,
  data: RealtimeEventMap[E],
  selfId: string,
): QueryKey[] {
  const me = (...rest: string[]) => ['subject', selfId, ...rest];
  switch (event) {
    case 'wallet.updated':
      return [me('wallet'), me('transactions'), me('transaction'), me('debts')];
    case 'payment.updated': {
      const { paymentId } = data as RealtimeEventMap['payment.updated'];
      return [me('payment', paymentId)];
    }
    case 'notification.created':
      return [me('notifications')];
    case 'training.updated': {
      const { trainingId } = data as RealtimeEventMap['training.updated'];
      return [
        me('trainings'),
        trainingId ? me('training', trainingId) : me('training'),
        ['admin', 'trainings'],
        trainingId ? ['admin', 'training', trainingId] : ['admin', 'training'],
        ['admin', 'attendance-queue'],
        ['admin', 'dashboard'],
      ];
    }
    case 'reservation.updated': {
      const { trainingId } = data as RealtimeEventMap['reservation.updated'];
      return [['admin', 'training', trainingId]];
    }
    case 'admin.activity': {
      const { userId } = data as RealtimeEventMap['admin.activity'];
      return [
        ['admin', 'dashboard'],
        ['admin', 'wallets'],
        ['admin', 'transactions'],
        ['admin', 'reports'],
        ...(userId ? [['admin', 'user', userId]] : []),
      ];
    }
    default:
      return [];
  }
}

export { REALTIME_EVENTS };
