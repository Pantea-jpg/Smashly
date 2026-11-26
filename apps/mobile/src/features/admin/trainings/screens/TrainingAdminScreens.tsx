import { useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { hapticSuccess, useRefreshOnFocus } from '../../../../shared/feedback/feedback';
import { minorToInput, parseAmountToMinor } from '../../../../shared/format/amount';
import { fromLocalParts, toLocalParts, useFormatDate } from '../../../../shared/format/date';
import { useErrorMessage } from '../../../../shared/i18n/useErrorMessage';
import { useTheme } from '../../../../shared/theme/ThemeProvider';
import { AppText } from '../../../../shared/ui/AppText';
import { Button } from '../../../../shared/ui/Button';
import { FormError } from '../../../../shared/ui/FormScreen';
import { ListRow } from '../../../../shared/ui/ListRow';
import { ListScreen } from '../../../../shared/ui/ListScreen';
import { MoneyText } from '../../../../shared/ui/MoneyText';
import { Screen } from '../../../../shared/ui/Screen';
import { Section } from '../../../../shared/ui/Section';
import { SegmentedControl } from '../../../../shared/ui/SegmentedControl';
import { Banner, Chip, ErrorState, Skeleton } from '../../../../shared/ui/States';
import { TextField } from '../../../../shared/ui/TextField';
import { useAdminTraining, useAdminTrainings, useCancelTraining, useSaveTraining } from '../../api';
import type { AdminTrainingsProps } from '../navigation';

const STATUS_TONE = { SCHEDULED: 'accent', CANCELLED: 'danger', COMPLETED: 'success' } as const;

export function AdminTrainingsListScreen({
  navigation,
}: AdminTrainingsProps<'AdminTrainingsList'>) {
  const { t } = useTranslation('manage');
  const { dateTime } = useFormatDate();
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming');
  const query = useAdminTrainings(scope);
  useRefreshOnFocus(query.refetch);
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Button
          testID="new-training"
          variant="link"
          label={t('trainings.new')}
          onPress={() => navigation.navigate('TrainingForm', {})}
        />
      ),
    });
  }, [navigation, t]);

  return (
    <ListScreen
      testID="admin-trainings-list"
      header={
        <SegmentedControl
          accessibilityLabel={t('trainings.upcoming')}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'upcoming', label: t('trainings.upcoming') },
            { value: 'past', label: t('trainings.past') },
          ]}
        />
      }
      data={scope === 'past' ? [...items].reverse() : items}
      keyExtractor={(tr) => tr.id}
      isPending={query.isPending}
      error={query.error}
      emptyMessage={t('trainings.empty')}
      refreshing={query.isRefetching && !query.isFetchingNextPage}
      onRefresh={query.refetch}
      onEndReached={() =>
        query.hasNextPage && !query.isFetchingNextPage ? query.fetchNextPage() : undefined
      }
      renderItem={(tr) => (
        <ListRow
          testID={`admin-training-${tr.id}`}
          title={tr.title}
          subtitle={`${dateTime(tr.startsAt)} · ${tr.counts.attending}${tr.capacity ? `/${tr.capacity}` : ''}`}
          trailing={
            <Chip label={t(`trainings.status.${tr.status}`)} tone={STATUS_TONE[tr.status]} />
          }
          onPress={() => navigation.navigate('AdminTrainingDetail', { trainingId: tr.id })}
        />
      )}
    />
  );
}

export function AdminTrainingDetailScreen({
  route,
  navigation,
}: AdminTrainingsProps<'AdminTrainingDetail'>) {
  const { trainingId } = route.params;
  const { t } = useTranslation('manage');
  const { t: tm } = useTranslation('member');
  const theme = useTheme();
  const { range } = useFormatDate();
  const training = useAdminTraining(trainingId);
  useRefreshOnFocus(training.refetch);

  if (training.isPending) {
    return (
      <Screen>
        <Skeleton rows={3} />
      </Screen>
    );
  }
  if (!training.data) {
    return (
      <Screen>
        <ErrorState error={training.error} onRetry={() => void training.refetch()} />
      </Screen>
    );
  }
  const tr = training.data;
  const cancelled = tr.status === 'CANCELLED';

  return (
    <Screen testID="admin-training-detail">
      <View style={{ gap: theme.spacing.sm }}>
        <AppText variant="title1" accessibilityRole="header">
          {tr.title}
        </AppText>
        <Chip
          testID="admin-training-status"
          label={t(`trainings.status.${tr.status}`)}
          tone={STATUS_TONE[tr.status]}
        />
      </View>
      {cancelled ? (
        <Banner
          tone="danger"
          message={tm('trainings.cancelled', { reason: tr.cancellationReason ?? '' })}
        />
      ) : null}
      <Section>
        <ListRow title={tm('trainings.when')} subtitle={range(tr.startsAt, tr.endsAt)} />
        <ListRow title={tm('trainings.location')} subtitle={tr.location} />
        <ListRow
          title={tm('trainings.places')}
          subtitle={
            tr.capacity === null
              ? tm('trainings.unlimited')
              : `${tr.counts.attending}/${tr.capacity}`
          }
        />
        <ListRow
          title={tm('trainings.priceSource.TRAINING_DEFAULT')}
          trailing={<MoneyText value={tr.defaultPrice} variant="headline" />}
        />
      </Section>
      <AppText testID="admin-training-counts" tone="textSecondary">
        {t('trainings.counts', tr.counts)}
      </AppText>
      <Section>
        <ListRow
          testID="open-reservations"
          title={t('trainings.actions.reservations')}
          onPress={() => navigation.navigate('Reservations', { trainingId })}
        />
        <ListRow
          testID="open-prices"
          title={t('trainings.actions.prices')}
          onPress={() => navigation.navigate('Prices', { trainingId })}
        />
        <ListRow
          testID="open-attendance"
          title={t('trainings.actions.attendance')}
          onPress={() => navigation.navigate('Attendance', { trainingId })}
        />
        {!cancelled ? (
          <ListRow
            testID="edit-training"
            title={t('trainings.actions.edit')}
            onPress={() => navigation.navigate('TrainingForm', { trainingId })}
          />
        ) : null}
        {!cancelled ? (
          <ListRow
            testID="cancel-training"
            destructive
            title={t('trainings.actions.cancel')}
            onPress={() =>
              navigation.navigate('CancelTraining', {
                trainingId,
                finalized: tr.finalizedAt !== null,
              })
            }
          />
        ) : null}
      </Section>
    </Screen>
  );
}

/** Create or edit. Times are typed in the device's local time zone. */
export function TrainingFormScreen({ route, navigation }: AdminTrainingsProps<'TrainingForm'>) {
  const trainingId = route.params.trainingId ?? null;
  const existing = useAdminTraining(trainingId ?? 'none');
  if (trainingId && existing.isPending) {
    return (
      <Screen>
        <Skeleton rows={4} />
      </Screen>
    );
  }
  return (
    <TrainingForm
      trainingId={trainingId}
      initial={trainingId ? existing.data : undefined}
      onDone={() => navigation.goBack()}
    />
  );
}

function TrainingForm({
  trainingId,
  initial,
  onDone,
}: {
  trainingId: string | null;
  initial: ReturnType<typeof useAdminTraining>['data'];
  onDone: () => void;
}) {
  const { t } = useTranslation('manage');
  const errorMessage = useErrorMessage();
  const save = useSaveTraining(trainingId);
  // Default for a new training: tomorrow 19:00 local (computed once, keeps render pure).
  const [tomorrow] = useState(() => {
    const d = new Date(Date.now() + 86_400_000);
    d.setHours(19, 0, 0, 0);
    return d;
  });
  const start = toLocalParts(initial?.startsAt ?? tomorrow.toISOString());
  const end = toLocalParts(
    initial?.endsAt ?? new Date(tomorrow.getTime() + 3_600_000).toISOString(),
  );
  const deadlineHours = initial
    ? Math.round(
        (Date.parse(initial.startsAt) - Date.parse(initial.reservationDeadline)) / 3_600_000,
      )
    : 0;
  const finalized = Boolean(initial?.finalizedAt);
  const [f, setF] = useState({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    location: initial?.location ?? '',
    date: start.date,
    start: start.time,
    end: end.time,
    capacity: initial?.capacity ? String(initial.capacity) : '',
    price: minorToInput(initial?.defaultPrice.amountMinor ?? 1000),
    deadline: String(deadlineHours),
  });
  const [touched, setTouched] = useState(false);
  const set = (key: keyof typeof f) => (value: string) =>
    setF((prev) => ({ ...prev, [key]: value }));

  const startsAt = fromLocalParts(f.date, f.start);
  const endsAt = fromLocalParts(f.date, f.end);
  const priceMinor = parseAmountToMinor(f.price);
  const capacity = f.capacity.trim() === '' ? null : Number(f.capacity);
  const deadline = Number(f.deadline || '0');
  const errors = {
    title: f.title.trim() ? undefined : t('trainings.form.required'),
    location: f.location.trim() ? undefined : t('trainings.form.required'),
    date: startsAt ? undefined : t('trainings.form.invalidDate'),
    end: !endsAt
      ? t('trainings.form.invalidTime')
      : startsAt && endsAt <= startsAt
        ? t('trainings.form.endBeforeStart')
        : undefined,
    capacity:
      capacity === null || (Number.isInteger(capacity) && capacity > 0)
        ? undefined
        : t('trainings.form.invalidNumber'),
    price: priceMinor === null ? t('trainings.form.invalidNumber') : undefined,
    deadline:
      Number.isFinite(deadline) && deadline >= 0 ? undefined : t('trainings.form.invalidNumber'),
  };
  const valid = Object.values(errors).every((e) => e === undefined);
  const show = (e: string | undefined) => (touched ? e : undefined);

  const submit = () => {
    setTouched(true);
    if (!valid || !startsAt || !endsAt || priceMinor === null) return;
    const base = {
      title: f.title.trim(),
      description: f.description.trim() || null,
      location: f.location.trim(),
    };
    const input = finalized
      ? base
      : {
          ...base,
          startsAt,
          endsAt,
          capacity,
          defaultPriceMinor: priceMinor,
          reservationDeadline: new Date(Date.parse(startsAt) - deadline * 3_600_000).toISOString(),
        };
    save.mutate(input as Parameters<typeof save.mutate>[0], {
      onSuccess: () => {
        hapticSuccess();
        onDone();
      },
    });
  };

  return (
    <Screen testID="training-form">
      <TextField
        testID="tf-title"
        label={t('trainings.form.title')}
        value={f.title}
        onChangeText={set('title')}
        error={show(errors.title)}
      />
      <TextField
        testID="tf-location"
        label={t('trainings.form.location')}
        value={f.location}
        onChangeText={set('location')}
        error={show(errors.location)}
      />
      <TextField
        testID="tf-description"
        label={t('trainings.form.description')}
        value={f.description}
        onChangeText={set('description')}
        multiline
      />
      {!finalized ? (
        <>
          <TextField
            testID="tf-date"
            label={t('trainings.form.date')}
            value={f.date}
            onChangeText={set('date')}
            error={show(errors.date)}
            autoCorrect={false}
          />
          <TextField
            testID="tf-start"
            label={t('trainings.form.start')}
            value={f.start}
            onChangeText={set('start')}
            error={show(errors.date)}
            keyboardType="numbers-and-punctuation"
          />
          <TextField
            testID="tf-end"
            label={t('trainings.form.end')}
            value={f.end}
            onChangeText={set('end')}
            error={show(errors.end)}
            keyboardType="numbers-and-punctuation"
          />
          <TextField
            testID="tf-capacity"
            label={t('trainings.form.capacity')}
            value={f.capacity}
            onChangeText={set('capacity')}
            error={show(errors.capacity)}
            keyboardType="number-pad"
          />
          <TextField
            testID="tf-price"
            label={t('trainings.form.price')}
            value={f.price}
            onChangeText={set('price')}
            error={show(errors.price)}
            keyboardType="decimal-pad"
          />
          <TextField
            testID="tf-deadline"
            label={t('trainings.form.deadline')}
            value={f.deadline}
            onChangeText={set('deadline')}
            error={show(errors.deadline)}
            keyboardType="number-pad"
          />
        </>
      ) : null}
      <FormError message={errorMessage(save.error)} />
      <Button
        testID="save-training"
        label={trainingId ? t('trainings.edit') : t('trainings.new')}
        loading={save.isPending}
        onPress={submit}
      />
    </Screen>
  );
}

export function CancelTrainingScreen({ route, navigation }: AdminTrainingsProps<'CancelTraining'>) {
  const { trainingId, finalized } = route.params;
  const { t } = useTranslation('manage');
  const errorMessage = useErrorMessage();
  const cancel = useCancelTraining(trainingId);
  const [reason, setReason] = useState('');
  return (
    <Screen testID="cancel-training-screen">
      <AppText variant="title2">{t('trainings.cancelTitle')}</AppText>
      {finalized ? <Banner tone="warning" message={t('trainings.cancelFinalizedWarning')} /> : null}
      <TextField
        testID="cancel-reason"
        label={t('trainings.cancelReason')}
        value={reason}
        onChangeText={setReason}
        multiline
      />
      <FormError message={errorMessage(cancel.error)} />
      <Button
        testID="confirm-cancel-training"
        variant="destructive"
        label={t('trainings.actions.cancel')}
        disabled={reason.trim().length < 3}
        loading={cancel.isPending}
        onPress={() =>
          cancel.mutate(reason.trim(), {
            onSuccess: () => {
              hapticSuccess();
              navigation.goBack();
            },
          })
        }
      />
    </Screen>
  );
}
