import type { AttendanceRow, AttendanceStatus } from '@tw/contracts';
import { money } from '@tw/money';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { isApiError } from '../../../../shared/api/http';
import { useIdempotencyKey } from '../../../../shared/api/idempotency';
import { confirm, hapticSuccess, useRefreshOnFocus } from '../../../../shared/feedback/feedback';
import { minorToInput, parseAmountToMinor } from '../../../../shared/format/amount';
import { useFormatDate } from '../../../../shared/format/date';
import { useFormatMoney } from '../../../../shared/format/money';
import { useNow } from '../../../../shared/hooks/useNow';
import { useErrorMessage } from '../../../../shared/i18n/useErrorMessage';
import { useTheme } from '../../../../shared/theme/ThemeProvider';
import { AppText } from '../../../../shared/ui/AppText';
import { Button } from '../../../../shared/ui/Button';
import { FormError } from '../../../../shared/ui/FormScreen';
import { ListRow } from '../../../../shared/ui/ListRow';
import { ListScreen } from '../../../../shared/ui/ListScreen';
import { MoneyText } from '../../../../shared/ui/MoneyText';
import { Screen } from '../../../../shared/ui/Screen';
import { SegmentedControl } from '../../../../shared/ui/SegmentedControl';
import { Banner, Chip, ErrorState, Skeleton } from '../../../../shared/ui/States';
import { TextField } from '../../../../shared/ui/TextField';
import {
  useAdminTraining,
  useAttendance,
  useAttendanceQueue,
  useCorrectAttendance,
  useFinalize,
  useMarkAttendance,
  usePrices,
  useReservations,
  useSetPriceOverride,
  useSetReservation,
} from '../../api';
import type { AdminTrainingsProps } from '../navigation';

type Marked = Exclude<AttendanceStatus, 'PENDING'>;
const nameOf = (u: { firstName: string; lastName: string; email: string }) =>
  `${u.firstName} ${u.lastName}`.trim() || u.email;

function useMoneyFormat() {
  const formatMoney = useFormatMoney();
  return (m: { amountMinor: number; currency: string }) =>
    formatMoney(money(m.amountMinor, m.currency as 'EUR'));
}

// ── Attendance ──────────────────────────────────────────────────────────────

export function AttendanceScreen({ route, navigation }: AdminTrainingsProps<'Attendance'>) {
  const { trainingId } = route.params;
  const { t } = useTranslation('manage');
  const { t: tm } = useTranslation('member');
  const { t: tc } = useTranslation('common');
  const fmt = useMoneyFormat();
  const errorMessage = useErrorMessage();
  const training = useAdminTraining(trainingId);
  const rows = useAttendance(trainingId);
  const mark = useMarkAttendance(trainingId);
  const finalize = useFinalize(trainingId);
  const idempotency = useIdempotencyKey();
  const [draft, setDraft] = useState<Record<string, Marked>>({});
  const [result, setResult] = useState<string | null>(null);
  const now = useNow();
  useRefreshOnFocus(rows.refetch);

  if (training.isPending || rows.isPending) {
    return (
      <Screen>
        <Skeleton rows={4} />
      </Screen>
    );
  }
  if (!training.data || !rows.data) {
    return (
      <Screen>
        <ErrorState error={training.error ?? rows.error} onRetry={() => void rows.refetch()} />
      </Screen>
    );
  }

  const tr = training.data;
  const list = rows.data;
  const finalized = tr.finalizedAt !== null;
  const started = Date.parse(tr.startsAt) <= now;
  const editable = !finalized && started && tr.status === 'SCHEDULED';
  const statusOf = (r: AttendanceRow): AttendanceStatus => draft[r.user.id] ?? r.status;
  const changes = list
    .filter((r) => draft[r.user.id] && draft[r.user.id] !== r.status)
    .map((r) => ({ userId: r.user.id, status: draft[r.user.id]! }));

  const submitFinalize = (pendingAsAbsent: boolean) =>
    finalize.mutate(
      { pendingAsAbsent, headers: idempotency.headers },
      {
        onSuccess: (r) => {
          idempotency.renew();
          hapticSuccess();
          setResult(
            t('attendance.finalized', {
              count: r.charged,
              total: fmt(r.totalCharged),
              debt: fmt(r.debtCreated),
            }),
          );
        },
        onError: (error) => {
          if (!isApiError(error, 'ATTENDANCE_HAS_PENDING')) return;
          const pending = (error.details as { pending?: number } | undefined)?.pending ?? 0;
          void confirm({
            title: t('attendance.pendingTitle'),
            message: t('attendance.pendingBody', { count: pending }),
            confirmLabel: t('attendance.markAbsentAndFinalize'),
            cancelLabel: tc('actions.cancel'),
          }).then((again) => again && submitFinalize(true));
        },
      },
    );

  const onFinalize = async () => {
    const present = list.filter((r) => statusOf(r) === 'PRESENT').length;
    const ok = await confirm({
      title: t('attendance.finalizeTitle'),
      message: t('attendance.finalizeBody', { count: present }),
      confirmLabel: t('attendance.finalize'),
      cancelLabel: tc('actions.cancel'),
    });
    if (!ok) return;
    if (changes.length === 0) return submitFinalize(false);
    // Save unsaved marks first, then finalize.
    mark.mutate(changes, {
      onSuccess: () => {
        setDraft({});
        submitFinalize(false);
      },
    });
  };

  const finalizeError =
    finalize.error && !isApiError(finalize.error, 'ATTENDANCE_HAS_PENDING') ? finalize.error : null;

  return (
    <ListScreen
      testID="attendance-screen"
      header={
        <>
          {!started && !finalized ? (
            <Banner tone="accent" message={t('attendance.notStarted')} />
          ) : null}
          {result ? <Banner testID="finalize-result" tone="success" message={result} /> : null}
          {finalized && !result ? (
            <Chip label={t('trainings.status.COMPLETED')} tone="success" />
          ) : null}
          <FormError message={errorMessage(mark.error ?? finalizeError)} />
        </>
      }
      footer={
        editable ? (
          <>
            <Button
              testID="save-attendance"
              variant="secondary"
              label={t('attendance.save')}
              disabled={changes.length === 0}
              loading={mark.isPending && !finalize.isPending}
              onPress={() =>
                mark.mutate(changes, {
                  onSuccess: () => {
                    setDraft({});
                    hapticSuccess();
                  },
                })
              }
            />
            <Button
              testID="finalize-attendance"
              label={t('attendance.finalize')}
              loading={finalize.isPending}
              onPress={() => void onFinalize()}
            />
          </>
        ) : undefined
      }
      data={list}
      keyExtractor={(r) => r.user.id}
      isPending={false}
      error={null}
      emptyMessage={tm('trainings.empty')}
      refreshing={rows.isRefetching}
      onRefresh={rows.refetch}
      renderItem={(r) => (
        <AttendanceRowItem
          row={r}
          status={statusOf(r)}
          editable={editable}
          correctable={finalized && tr.status !== 'CANCELLED'}
          onMark={(status) => setDraft((d) => ({ ...d, [r.user.id]: status }))}
          onCorrect={() =>
            navigation.navigate('Correction', {
              trainingId,
              userId: r.user.id,
              name: nameOf(r.user),
            })
          }
        />
      )}
    />
  );
}

function AttendanceRowItem({
  row,
  status,
  editable,
  correctable,
  onMark,
  onCorrect,
}: {
  row: AttendanceRow;
  status: AttendanceStatus;
  editable: boolean;
  correctable: boolean;
  onMark: (status: Marked) => void;
  onCorrect: () => void;
}) {
  const { t } = useTranslation('manage');
  const { t: tm } = useTranslation('member');
  const theme = useTheme();
  const fmt = useMoneyFormat();
  const name = nameOf(row.user);
  const charge = row.charge;
  return (
    <View
      testID={`attendance-row-${row.user.id}`}
      style={{ gap: theme.spacing.sm, paddingVertical: theme.spacing.md }}
    >
      <View
        style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.sm }}
      >
        <View style={{ flex: 1 }}>
          <AppText variant="headline">{name}</AppText>
          <AppText variant="footnote" tone="textSecondary">
            {row.reservation
              ? tm(`trainings.status.${row.reservation}`)
              : tm('trainings.status.none')}{' '}
            · {fmt(row.price.price)}
          </AppText>
        </View>
        {charge ? (
          <Chip
            testID={`charge-${row.user.id}`}
            label={
              charge.status === 'REVERSED'
                ? tm('trainings.chargeReversed')
                : tm('trainings.charged', { amount: fmt(charge.unitPrice) })
            }
            tone={
              charge.status === 'REVERSED'
                ? 'textSecondary'
                : charge.shortfall.amountMinor > 0
                  ? 'warning'
                  : 'success'
            }
          />
        ) : null}
      </View>
      {editable ? (
        <SegmentedControl<Marked | 'PENDING'>
          testID={`mark-${row.user.id}`}
          accessibilityLabel={name}
          value={status}
          onChange={(value) => value !== 'PENDING' && onMark(value)}
          options={[
            { value: 'PRESENT', label: tm('trainings.attendance.PRESENT') },
            { value: 'ABSENT', label: tm('trainings.attendance.ABSENT') },
            { value: 'EXCUSED', label: tm('trainings.attendance.EXCUSED') },
          ]}
        />
      ) : (
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <AppText>{tm(`trainings.attendance.${status}`)}</AppText>
          {correctable ? (
            <Button
              testID={`correct-${row.user.id}`}
              variant="link"
              label={t('attendance.correct')}
              onPress={onCorrect}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

export function CorrectionScreen({ route, navigation }: AdminTrainingsProps<'Correction'>) {
  const { trainingId, userId, name } = route.params;
  const { t } = useTranslation('manage');
  const { t: tm } = useTranslation('member');
  const errorMessage = useErrorMessage();
  const correct = useCorrectAttendance(trainingId);
  const idempotency = useIdempotencyKey();
  const [status, setStatus] = useState<'PRESENT' | 'ABSENT' | 'EXCUSED'>('ABSENT');
  const [reason, setReason] = useState('');
  return (
    <Screen testID="correction-screen">
      <AppText variant="title2">{t('attendance.correctTitle', { name })}</AppText>
      <SegmentedControl
        testID="correction-status"
        accessibilityLabel={t('attendance.correct')}
        value={status}
        onChange={setStatus}
        options={[
          { value: 'PRESENT', label: tm('trainings.attendance.PRESENT') },
          { value: 'ABSENT', label: tm('trainings.attendance.ABSENT') },
          { value: 'EXCUSED', label: tm('trainings.attendance.EXCUSED') },
        ]}
      />
      <TextField
        testID="correction-reason"
        label={t('attendance.reason')}
        value={reason}
        onChangeText={setReason}
        multiline
      />
      <FormError message={errorMessage(correct.error)} />
      <Button
        testID="submit-correction"
        label={t('attendance.correct')}
        disabled={reason.trim().length < 3}
        loading={correct.isPending}
        onPress={() =>
          correct.mutate(
            { userId, status, reason: reason.trim(), headers: idempotency.headers },
            {
              onSuccess: () => {
                hapticSuccess();
                navigation.goBack();
              },
            },
          )
        }
      />
    </Screen>
  );
}

// ── Responses ───────────────────────────────────────────────────────────────

export function ReservationsScreen({ route }: AdminTrainingsProps<'Reservations'>) {
  const { trainingId } = route.params;
  const { t } = useTranslation('manage');
  const { t: tm } = useTranslation('member');
  const { t: tc } = useTranslation('common');
  const errorMessage = useErrorMessage();
  const query = useReservations(trainingId);
  const setReservation = useSetReservation(trainingId);

  const toggle = (userId: string, name: string, current: string | null) => {
    const status = current === 'ATTENDING' ? 'NOT_ATTENDING' : 'ATTENDING';
    setReservation.mutate(
      { userId, status },
      {
        onError: (error) => {
          if (!isApiError(error, 'TRAINING_FULL')) return;
          void confirm({
            title: t('reservations.fullTitle'),
            message: t('reservations.fullBody', { name }),
            confirmLabel: t('reservations.force'),
            cancelLabel: tc('actions.cancel'),
          }).then((ok) => ok && setReservation.mutate({ userId, status, force: true }));
        },
      },
    );
  };

  return (
    <ListScreen
      testID="reservations-screen"
      header={
        setReservation.error && !isApiError(setReservation.error, 'TRAINING_FULL') ? (
          <FormError message={errorMessage(setReservation.error)} />
        ) : undefined
      }
      data={query.data ?? []}
      keyExtractor={(r) => r.user.id}
      isPending={query.isPending}
      error={query.error}
      emptyMessage={tm('trainings.empty')}
      refreshing={query.isRefetching}
      onRefresh={query.refetch}
      renderItem={(r) => (
        <ListRow
          testID={`reservation-${r.user.id}`}
          title={nameOf(r.user)}
          subtitle={`${r.status ? tm(`trainings.status.${r.status}`) : tm('trainings.status.none')}${r.respondedByAdmin ? ` · ${t('reservations.byAdmin')}` : ''}`}
          trailing={
            <Button
              variant="link"
              label={
                r.status === 'ATTENDING'
                  ? t('reservations.setNotAttending')
                  : t('reservations.setAttending')
              }
              onPress={() => toggle(r.user.id, nameOf(r.user), r.status)}
            />
          }
        />
      )}
    />
  );
}

// ── Prices ──────────────────────────────────────────────────────────────────

export function PricesScreen({ route, navigation }: AdminTrainingsProps<'Prices'>) {
  const { trainingId } = route.params;
  const { t: tm } = useTranslation('member');
  const query = usePrices(trainingId);
  useRefreshOnFocus(query.refetch);
  return (
    <ListScreen
      testID="prices-screen"
      data={query.data ?? []}
      keyExtractor={(r) => r.user.id}
      isPending={query.isPending}
      error={query.error}
      emptyMessage={tm('trainings.empty')}
      refreshing={query.isRefetching}
      onRefresh={query.refetch}
      renderItem={(r) => (
        <ListRow
          testID={`price-${r.user.id}`}
          title={nameOf(r.user)}
          subtitle={tm(`trainings.priceSource.${r.source}`)}
          trailing={<MoneyText value={r.price} variant="subhead" />}
          onPress={() =>
            navigation.navigate('PriceOverride', {
              trainingId,
              userId: r.user.id,
              name: nameOf(r.user),
              priceMinor: r.price.amountMinor,
              isOverride: r.source === 'TRAINING_OVERRIDE',
            })
          }
        />
      )}
    />
  );
}

export function PriceOverrideScreen({ route, navigation }: AdminTrainingsProps<'PriceOverride'>) {
  const { trainingId, userId, name, priceMinor, isOverride } = route.params;
  const { t } = useTranslation('manage');
  const { t: tc } = useTranslation('common');
  const errorMessage = useErrorMessage();
  const setOverride = useSetPriceOverride(trainingId);
  const [value, setValue] = useState(minorToInput(priceMinor));
  const parsed = parseAmountToMinor(value);
  const done = { onSuccess: () => navigation.goBack() };
  return (
    <Screen testID="price-override-screen">
      <AppText variant="title2">{t('prices.title', { name })}</AppText>
      <TextField
        testID="override-price"
        label={t('prices.label')}
        value={value}
        onChangeText={setValue}
        keyboardType="decimal-pad"
      />
      <FormError message={errorMessage(setOverride.error)} />
      <Button
        testID="save-override"
        label={tc('actions.save')}
        disabled={parsed === null}
        loading={setOverride.isPending}
        onPress={() => parsed !== null && setOverride.mutate({ userId, priceMinor: parsed }, done)}
      />
      {isOverride ? (
        <Button
          testID="remove-override"
          variant="secondary"
          label={t('prices.remove')}
          onPress={() => setOverride.mutate({ userId, priceMinor: null }, done)}
        />
      ) : null}
    </Screen>
  );
}

// ── Queue ───────────────────────────────────────────────────────────────────

export function AttendanceQueueScreen({ navigation }: AdminTrainingsProps<'AttendanceQueue'>) {
  const { t } = useTranslation('manage');
  const { dateTime } = useFormatDate();
  const query = useAttendanceQueue();
  useRefreshOnFocus(query.refetch);
  return (
    <ListScreen
      testID="attendance-queue"
      data={query.data ?? []}
      keyExtractor={(q) => q.training.id}
      isPending={query.isPending}
      error={query.error}
      emptyMessage={t('attendance.queueEmpty')}
      refreshing={query.isRefetching}
      onRefresh={query.refetch}
      renderItem={(q) => (
        <ListRow
          testID={`queue-${q.training.id}`}
          title={q.training.title}
          subtitle={`${dateTime(q.training.startsAt)} · ${t('attendance.endedAgo', { count: q.hoursSinceEnd })}`}
          trailing={
            q.pending > 0 ? (
              <Chip label={t('attendance.pending', { count: q.pending })} tone="warning" />
            ) : undefined
          }
          onPress={() => navigation.navigate('Attendance', { trainingId: q.training.id })}
        />
      )}
    />
  );
}
