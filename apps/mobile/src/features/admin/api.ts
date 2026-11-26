import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AdjustmentRequest,
  AdminReservationRowSchema,
  AdminSettingsSchema,
  AdminTrainingSchema,
  AdminTransactionSchema,
  AdminWalletSchema,
  AttendanceCorrectionResultSchema,
  AttendanceQueueItemSchema,
  AttendanceRowSchema,
  type AttendanceStatus,
  CancelTrainingResultSchema,
  DashboardSchema,
  FinalizeResultSchema,
  FinancialSummarySchema,
  LedgerResultSchema,
  PaymentSchema,
  type RefundRequest,
  offsetListEnvelope,
  type ReservationStatus,
  TrainingHistoryItemSchema,
  TrainingPriceRowSchema,
  type UpdateAdminSettingsRequest,
} from '@tw/contracts';
import { z } from 'zod';
import { queryKeys } from '../../shared/api/queryKeys';
import { sessionController } from '../../shared/auth/session';

const PAGE_SIZE = 25;
const TrainingPage = offsetListEnvelope(AdminTrainingSchema);
const TransactionPage = offsetListEnvelope(AdminTransactionSchema);
const WalletPage = offsetListEnvelope(AdminWalletSchema);
const HistoryPage = offsetListEnvelope(TrainingHistoryItemSchema);

const nextOffsetPage = (last: {
  meta: { page: { page: number; pageSize: number; total: number } };
}) => {
  const { page, pageSize, total } = last.meta.page;
  return page * pageSize < total ? page + 1 : undefined;
};

type IdemHeaders = Record<string, string>;

// ── Dashboard ───────────────────────────────────────────────────────────────

export function useAdminDashboard() {
  return useQuery({
    queryKey: queryKeys.adminDashboard(),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: '/admin/dashboard',
        schema: DashboardSchema,
      }),
  });
}

export function useFinancialSummary() {
  return useQuery({
    queryKey: queryKeys.adminSummary(),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: '/admin/reports/summary',
        schema: FinancialSummarySchema,
      }),
  });
}

// ── Trainings ───────────────────────────────────────────────────────────────

export function useAdminTrainings(scope: 'upcoming' | 'past') {
  return useInfiniteQuery({
    queryKey: queryKeys.adminTrainings(scope),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const now = new Date().toISOString();
      const params = new URLSearchParams({ page: String(pageParam), pageSize: String(PAGE_SIZE) });
      params.set(scope === 'upcoming' ? 'from' : 'to', now);
      return sessionController.request({
        method: 'GET',
        path: `/admin/trainings?${params.toString()}`,
        schema: TrainingPage,
        envelope: 'full',
      });
    },
    getNextPageParam: nextOffsetPage,
  });
}

export function useAdminTraining(id: string) {
  return useQuery({
    queryKey: queryKeys.adminTraining(id),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: `/admin/trainings/${id}`,
        schema: AdminTrainingSchema,
      }),
  });
}

export interface TrainingInput {
  title: string;
  description?: string | null;
  location: string;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  defaultPriceMinor: number;
  reservationDeadline?: string;
}

/** Refreshes everything that shows trainings after a change. */
function useInvalidateTrainings() {
  const queryClient = useQueryClient();
  return (id?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'trainings'] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.adminDashboard() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.adminQueue() }),
      ...(id ? [queryClient.invalidateQueries({ queryKey: queryKeys.adminTraining(id) })] : []),
    ]);
}

export function useSaveTraining(id: string | null) {
  const invalidate = useInvalidateTrainings();
  return useMutation({
    mutationFn: (input: TrainingInput) =>
      sessionController.request({
        method: id ? 'PATCH' : 'POST',
        path: id ? `/admin/trainings/${id}` : '/admin/trainings',
        body: input,
        schema: AdminTrainingSchema,
      }),
    onSuccess: (training) => invalidate(training.id),
  });
}

export function useCancelTraining(id: string) {
  const invalidate = useInvalidateTrainings();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      sessionController.request({
        method: 'POST',
        path: `/admin/trainings/${id}/cancel`,
        body: { reason },
        schema: CancelTrainingResultSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminAttendance(id) });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'wallets'] });
      return invalidate(id);
    },
  });
}

export function useReservations(id: string) {
  return useQuery({
    queryKey: queryKeys.adminReservations(id),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: `/admin/trainings/${id}/reservations`,
        schema: z.array(AdminReservationRowSchema),
      }),
  });
}

export function useSetReservation(id: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateTrainings();
  return useMutation({
    mutationFn: (input: { userId: string; status: ReservationStatus; force?: boolean }) =>
      sessionController.request({
        method: 'PUT',
        path: `/admin/trainings/${id}/reservations/${input.userId}`,
        body: { status: input.status, force: input.force ?? false },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminReservations(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminAttendance(id) });
      return invalidate(id);
    },
  });
}

export function usePrices(id: string) {
  return useQuery({
    queryKey: queryKeys.adminPrices(id),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: `/admin/trainings/${id}/prices`,
        schema: z.array(TrainingPriceRowSchema),
      }),
  });
}

export function useSetPriceOverride(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; priceMinor: number | null }) =>
      sessionController.request({
        method: input.priceMinor === null ? 'DELETE' : 'PUT',
        path: `/admin/trainings/${id}/price-overrides/${input.userId}`,
        ...(input.priceMinor === null ? {} : { body: { priceMinor: input.priceMinor } }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminPrices(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminAttendance(id) });
    },
  });
}

// ── Attendance ──────────────────────────────────────────────────────────────

export function useAttendance(id: string) {
  return useQuery({
    queryKey: queryKeys.adminAttendance(id),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: `/admin/trainings/${id}/attendance`,
        schema: z.array(AttendanceRowSchema),
      }),
  });
}

export function useMarkAttendance(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entries: { userId: string; status: AttendanceStatus }[]) =>
      sessionController.request({
        method: 'PUT',
        path: `/admin/trainings/${id}/attendance`,
        body: { entries },
        schema: z.array(AttendanceRowSchema),
      }),
    onSuccess: (rows) => {
      queryClient.setQueryData(queryKeys.adminAttendance(id), rows);
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminTraining(id) });
    },
  });
}

export function useFinalize(id: string) {
  const invalidate = useInvalidateTrainings();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { pendingAsAbsent: boolean; headers: IdemHeaders }) =>
      sessionController.request({
        method: 'POST',
        path: `/admin/trainings/${id}/attendance/finalize`,
        body: input.pendingAsAbsent ? { pendingAs: 'ABSENT' } : {},
        headers: input.headers,
        schema: FinalizeResultSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminAttendance(id) });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'wallets'] });
      return invalidate(id);
    },
  });
}

export function useCorrectAttendance(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      userId: string;
      status: 'PRESENT' | 'ABSENT' | 'EXCUSED';
      reason: string;
      headers: IdemHeaders;
    }) =>
      sessionController.request({
        method: 'POST',
        path: `/admin/trainings/${id}/attendance/${input.userId}/correction`,
        body: { status: input.status, reason: input.reason },
        headers: input.headers,
        schema: AttendanceCorrectionResultSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminAttendance(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminTraining(id) });
    },
  });
}

export function useAttendanceQueue() {
  return useQuery({
    queryKey: queryKeys.adminQueue(),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: '/admin/attendance/queue',
        schema: z.array(AttendanceQueueItemSchema),
      }),
  });
}

// ── Money on a user ─────────────────────────────────────────────────────────

function useInvalidateUserMoney(userId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUser(userId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUserPayments(userId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUserTransactions(userId) }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'wallets'] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.adminTransactions() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.adminDashboard() }),
    ]);
}

/** A member's online top-ups (Stripe), newest first: the payments a card refund can go back to. */
export function useUserPayments(userId: string) {
  return useQuery({
    queryKey: queryKeys.adminUserPayments(userId),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: `/admin/users/${userId}/payments`,
        schema: z.array(PaymentSchema),
      }),
  });
}

/** D17: unused balance back to the member, in cash or to the card of an online top-up. */
export function useRefund(userId: string) {
  const invalidate = useInvalidateUserMoney(userId);
  return useMutation({
    mutationFn: (input: RefundRequest & { headers: IdemHeaders }) =>
      sessionController.request({
        method: 'POST',
        path: `/admin/users/${userId}/refunds`,
        body: {
          method: input.method,
          amountMinor: input.amountMinor,
          reason: input.reason,
          ...(input.paymentId ? { paymentId: input.paymentId } : {}),
        },
        headers: input.headers,
        schema: LedgerResultSchema,
      }),
    onSuccess: invalidate,
  });
}

export function useCashPayment(userId: string) {
  const invalidate = useInvalidateUserMoney(userId);
  return useMutation({
    mutationFn: (input: { amountMinor: number; description?: string; headers: IdemHeaders }) =>
      sessionController.request({
        method: 'POST',
        path: `/admin/users/${userId}/cash-payments`,
        body: {
          amountMinor: input.amountMinor,
          ...(input.description ? { description: input.description } : {}),
        },
        headers: input.headers,
        schema: LedgerResultSchema,
      }),
    onSuccess: invalidate,
  });
}

export function useAdjustment(userId: string) {
  const invalidate = useInvalidateUserMoney(userId);
  return useMutation({
    mutationFn: (input: AdjustmentRequest & { headers: IdemHeaders }) =>
      sessionController.request({
        method: 'POST',
        path: `/admin/users/${userId}/adjustments`,
        body: { kind: input.kind, amountMinor: input.amountMinor, reason: input.reason },
        headers: input.headers,
        schema: LedgerResultSchema,
      }),
    onSuccess: invalidate,
  });
}

export function useReversal(userId: string) {
  const invalidate = useInvalidateUserMoney(userId);
  return useMutation({
    mutationFn: (input: { transactionId: string; reason: string; headers: IdemHeaders }) =>
      sessionController.request({
        method: 'POST',
        path: `/admin/transactions/${input.transactionId}/reversal`,
        body: { reason: input.reason },
        headers: input.headers,
        schema: LedgerResultSchema,
      }),
    onSuccess: invalidate,
  });
}

export function useUserTransactions(userId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.adminUserTransactions(userId),
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      sessionController.request({
        method: 'GET',
        path: `/admin/users/${userId}/transactions?page=${pageParam}&pageSize=${PAGE_SIZE}`,
        schema: TransactionPage,
        envelope: 'full',
      }),
    getNextPageParam: nextOffsetPage,
  });
}

export function useUserTrainings(userId: string) {
  return useQuery({
    queryKey: queryKeys.adminUserTrainings(userId),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: `/admin/users/${userId}/trainings?page=1&pageSize=10`,
        schema: HistoryPage,
        envelope: 'full',
      }),
  });
}

// ── Finance ─────────────────────────────────────────────────────────────────

export function useAdminWallets(q: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.adminWallets(q),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        page: String(pageParam),
        pageSize: String(PAGE_SIZE),
        sort: '-debt',
      });
      if (q.trim()) params.set('q', q.trim());
      return sessionController.request({
        method: 'GET',
        path: `/admin/wallets?${params.toString()}`,
        schema: WalletPage,
        envelope: 'full',
      });
    },
    getNextPageParam: nextOffsetPage,
  });
}

export function useAdminTransactions() {
  return useInfiniteQuery({
    queryKey: queryKeys.adminTransactions(),
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      sessionController.request({
        method: 'GET',
        path: `/admin/transactions?page=${pageParam}&pageSize=${PAGE_SIZE}`,
        schema: TransactionPage,
        envelope: 'full',
      }),
    getNextPageParam: nextOffsetPage,
  });
}

// ── Settings ────────────────────────────────────────────────────────────────

export function useAdminSettings() {
  return useQuery({
    queryKey: queryKeys.adminSettings(),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: '/admin/settings',
        schema: AdminSettingsSchema,
      }),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAdminSettingsRequest) =>
      sessionController.request({
        method: 'PATCH',
        path: '/admin/settings',
        body: input,
        schema: AdminSettingsSchema,
      }),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.adminSettings(), settings),
  });
}
