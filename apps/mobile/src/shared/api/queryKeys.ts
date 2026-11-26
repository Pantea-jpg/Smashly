import type { AdminUserListQuery } from '@tw/contracts';
import { useSessionStore } from '../auth/session';
import { useViewAsStore } from '../auth/viewAs';

/**
 * Query keys. Everything a "/me" endpoint returns is keyed by the subject's id, so data seen
 * in View-as mode never mixes with the admin's own, and can be dropped on exit.
 */
export const queryKeys = {
  subject: (subjectId: string) => ['subject', subjectId] as const,
  profile: (subjectId: string) => ['subject', subjectId, 'profile'] as const,
  preferences: (subjectId: string) => ['subject', subjectId, 'notification-preferences'] as const,
  wallet: (subjectId: string) => ['subject', subjectId, 'wallet'] as const,
  transactions: (subjectId: string) => ['subject', subjectId, 'transactions'] as const,
  transaction: (subjectId: string, id: string) =>
    ['subject', subjectId, 'transaction', id] as const,
  debts: (subjectId: string) => ['subject', subjectId, 'debts'] as const,
  payment: (subjectId: string, id: string) => ['subject', subjectId, 'payment', id] as const,
  trainings: (subjectId: string, scope: 'upcoming' | 'past') =>
    ['subject', subjectId, 'trainings', scope] as const,
  training: (subjectId: string, id: string) => ['subject', subjectId, 'training', id] as const,
  notifications: (subjectId: string) => ['subject', subjectId, 'notifications'] as const,
  unread: (subjectId: string) => ['subject', subjectId, 'notifications', 'unread'] as const,

  adminUsers: (filters: Partial<AdminUserListQuery>) => ['admin', 'users', filters] as const,
  adminUser: (userId: string) => ['admin', 'user', userId] as const,
  adminUserTransactions: (userId: string) => ['admin', 'user', userId, 'transactions'] as const,
  adminUserTrainings: (userId: string) => ['admin', 'user', userId, 'trainings'] as const,
  adminUserPayments: (userId: string) => ['admin', 'user', userId, 'payments'] as const,
  adminDashboard: () => ['admin', 'dashboard'] as const,
  adminTrainings: (scope: string) => ['admin', 'trainings', scope] as const,
  adminTraining: (id: string) => ['admin', 'training', id] as const,
  adminReservations: (id: string) => ['admin', 'training', id, 'reservations'] as const,
  adminPrices: (id: string) => ['admin', 'training', id, 'prices'] as const,
  adminAttendance: (id: string) => ['admin', 'training', id, 'attendance'] as const,
  adminQueue: () => ['admin', 'attendance-queue'] as const,
  adminWallets: (q: string) => ['admin', 'wallets', q] as const,
  adminTransactions: () => ['admin', 'transactions'] as const,
  adminSummary: () => ['admin', 'reports', 'summary'] as const,
  adminSettings: () => ['admin', 'settings'] as const,
};

/** The user whose data the user screens show: the viewed user in View-as mode, else yourself. */
export function useSubjectId(): string | null {
  const viewed = useViewAsStore((s) => s.session?.subject.id ?? null);
  const self = useSessionStore((s) => s.user?.id ?? null);
  return viewed ?? self;
}
