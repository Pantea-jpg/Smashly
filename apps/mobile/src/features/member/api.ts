import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cursorListEnvelope,
  DebtSchema,
  MeTrainingSchema,
  NotificationSchema,
  PaymentSchema,
  ReservationResultSchema,
  type ReservationStatus,
  TopUpIntentSchema,
  TrainingHistoryItemSchema,
  TransactionSchema,
  UnreadCountSchema,
  WalletSchema,
} from '@tw/contracts';
import { z } from 'zod';
import { queryKeys, useSubjectId } from '../../shared/api/queryKeys';
import { sessionController } from '../../shared/auth/session';

const TransactionPage = cursorListEnvelope(TransactionSchema);
const TrainingPage = cursorListEnvelope(MeTrainingSchema);
const NotificationPage = cursorListEnvelope(NotificationSchema);
const HistoryPage = cursorListEnvelope(TrainingHistoryItemSchema);

function useSubject(): string {
  return useSubjectId() ?? 'anonymous';
}

const cursorPath = (
  base: string,
  cursor: string | undefined,
  extra: Record<string, string> = {},
) => {
  const params = new URLSearchParams({ limit: '20', ...extra });
  if (cursor) params.set('cursor', cursor);
  return `${base}?${params.toString()}`;
};

// ── Wallet ──────────────────────────────────────────────────────────────────

export function useWallet() {
  const subject = useSubject();
  return useQuery({
    queryKey: queryKeys.wallet(subject),
    queryFn: () =>
      sessionController.request({ method: 'GET', path: '/me/wallet', schema: WalletSchema }),
  });
}

export function useTransactions() {
  const subject = useSubject();
  return useInfiniteQuery({
    queryKey: queryKeys.transactions(subject),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      sessionController.request({
        method: 'GET',
        path: cursorPath('/me/transactions', pageParam),
        schema: TransactionPage,
        envelope: 'full',
      }),
    getNextPageParam: (last) => last.meta.page.nextCursor ?? undefined,
  });
}

export function useTransaction(id: string) {
  const subject = useSubject();
  return useQuery({
    queryKey: queryKeys.transaction(subject, id),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: `/me/transactions/${id}`,
        schema: TransactionSchema,
      }),
  });
}

export function useDebts() {
  const subject = useSubject();
  return useQuery({
    queryKey: queryKeys.debts(subject),
    queryFn: () =>
      sessionController.request({ method: 'GET', path: '/me/debts', schema: z.array(DebtSchema) }),
  });
}

export function useCreateTopUp() {
  return useMutation({
    mutationFn: (input: {
      amountMinor: number;
      currency: string;
      idempotencyKey: Record<string, string>;
    }) =>
      sessionController.request({
        method: 'POST',
        path: '/me/wallet/top-ups',
        body: { amountMinor: input.amountMinor, currency: input.currency },
        headers: input.idempotencyKey,
        schema: TopUpIntentSchema,
      }),
  });
}

export function usePaymentStatus(paymentId: string | null) {
  const subject = useSubject();
  return useQuery({
    queryKey: queryKeys.payment(subject, paymentId ?? 'none'),
    enabled: paymentId !== null,
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: `/me/payments/${paymentId}`,
        schema: PaymentSchema,
      }),
    // The wallet is credited by Stripe's webhook, usually within seconds: poll until settled.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined || status === 'REQUIRES_PAYMENT' || status === 'PROCESSING'
        ? 2000
        : false;
    },
  });
}

/** Everything money-related for the current subject (after a payment or a charge). */
export function useInvalidateMoney() {
  const queryClient = useQueryClient();
  const subject = useSubject();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.wallet(subject) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.transactions(subject) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.debts(subject) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.unread(subject) }),
    ]);
}

// ── Trainings ───────────────────────────────────────────────────────────────

export function useMyTrainings(scope: 'upcoming' | 'past') {
  const subject = useSubject();
  return useInfiniteQuery({
    queryKey: queryKeys.trainings(subject, scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      sessionController.request({
        method: 'GET',
        path: cursorPath('/me/trainings', pageParam, { scope }),
        schema: TrainingPage,
        envelope: 'full',
      }),
    getNextPageParam: (last) => last.meta.page.nextCursor ?? undefined,
  });
}

export function useMyTraining(id: string) {
  const subject = useSubject();
  return useQuery({
    queryKey: queryKeys.training(subject, id),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: `/me/trainings/${id}`,
        schema: MeTrainingSchema,
      }),
  });
}

export function useReserve(trainingId: string) {
  const queryClient = useQueryClient();
  const subject = useSubject();
  return useMutation({
    mutationFn: (status: ReservationStatus) =>
      sessionController.request({
        method: 'PUT',
        path: `/me/trainings/${trainingId}/reservation`,
        body: { status },
        schema: ReservationResultSchema,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.training(subject, trainingId), result.training);
      void queryClient.invalidateQueries({ queryKey: ['subject', subject, 'trainings'] });
    },
  });
}

export function useAttendanceHistory() {
  const subject = useSubject();
  return useInfiniteQuery({
    queryKey: [...queryKeys.trainings(subject, 'past'), 'attendance'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      sessionController.request({
        method: 'GET',
        path: cursorPath('/me/attendance', pageParam),
        schema: HistoryPage,
        envelope: 'full',
      }),
    getNextPageParam: (last) => last.meta.page.nextCursor ?? undefined,
  });
}

// ── Notifications ───────────────────────────────────────────────────────────

export function useNotifications() {
  const subject = useSubject();
  return useInfiniteQuery({
    queryKey: queryKeys.notifications(subject),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      sessionController.request({
        method: 'GET',
        path: cursorPath('/me/notifications', pageParam),
        schema: NotificationPage,
        envelope: 'full',
      }),
    getNextPageParam: (last) => last.meta.page.nextCursor ?? undefined,
  });
}

export function useUnreadCount() {
  const subject = useSubject();
  return useQuery({
    queryKey: queryKeys.unread(subject),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: '/me/notifications/unread-count',
        schema: UnreadCountSchema,
      }),
    refetchInterval: 60_000,
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  const subject = useSubject();
  return useMutation({
    mutationFn: () =>
      sessionController.request({
        method: 'POST',
        path: '/me/notifications/read',
        body: { all: true },
        schema: UnreadCountSchema,
      }),
    onSuccess: (count) => {
      queryClient.setQueryData(queryKeys.unread(subject), count);
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications(subject) });
    },
  });
}
