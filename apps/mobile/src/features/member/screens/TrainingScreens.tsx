import { money } from '@tw/money';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useCanMutate } from '../../../shared/auth/viewAs';
import { hapticSuccess, useRefreshOnFocus } from '../../../shared/feedback/feedback';
import { useFormatDate } from '../../../shared/format/date';
import { useFormatMoney } from '../../../shared/format/money';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { Card } from '../../../shared/ui/Card';
import { FormError } from '../../../shared/ui/FormScreen';
import { ListRow } from '../../../shared/ui/ListRow';
import { ListScreen } from '../../../shared/ui/ListScreen';
import { MoneyText } from '../../../shared/ui/MoneyText';
import { Screen } from '../../../shared/ui/Screen';
import { Section } from '../../../shared/ui/Section';
import { SegmentedControl } from '../../../shared/ui/SegmentedControl';
import { Banner, Chip, ErrorState, Skeleton } from '../../../shared/ui/States';
import { useMyTraining, useMyTrainings, useReserve } from '../api';
import { trainingState } from '../format';
import type { TrainingsScreenProps } from '../navigation';

export function TrainingsListScreen({ navigation }: TrainingsScreenProps<'TrainingsList'>) {
  const { t } = useTranslation('member');
  const { dateTime } = useFormatDate();
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming');
  const query = useMyTrainings(scope);
  useRefreshOnFocus(query.refetch);
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <ListScreen
      testID="trainings-list"
      header={
        <SegmentedControl
          testID="trainings-scope"
          accessibilityLabel={t('trainings.upcoming')}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'upcoming', label: t('trainings.upcoming') },
            { value: 'past', label: t('trainings.past') },
          ]}
        />
      }
      data={items}
      keyExtractor={(tr) => tr.id}
      isPending={query.isPending}
      error={query.error}
      emptyMessage={t('trainings.empty')}
      refreshing={query.isRefetching && !query.isFetchingNextPage}
      onRefresh={query.refetch}
      onEndReached={() =>
        query.hasNextPage && !query.isFetchingNextPage ? query.fetchNextPage() : undefined
      }
      renderItem={(tr) => {
        const state = trainingState(tr);
        return (
          <ListRow
            testID={`training-${tr.id}`}
            title={tr.title}
            subtitle={`${dateTime(tr.startsAt)} · ${tr.location}`}
            trailing={<Chip label={t(`trainings.status.${state.key}`)} tone={state.tone} />}
            onPress={() => navigation.navigate('TrainingDetail', { trainingId: tr.id })}
          />
        );
      }}
    />
  );
}

export function TrainingDetailScreen({ route }: TrainingsScreenProps<'TrainingDetail'>) {
  const { trainingId } = route.params;
  const { t } = useTranslation('member');
  const theme = useTheme();
  const { range, dateTime } = useFormatDate();
  const formatMoney = useFormatMoney();
  const errorMessage = useErrorMessage();
  const canMutate = useCanMutate();
  const training = useMyTraining(trainingId);
  const reserve = useReserve(trainingId);
  const [warning, setWarning] = useState(false);

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
  const state = trainingState(tr);
  const closed = tr.status !== 'SCHEDULED' || tr.deadlinePassed || tr.finalizedAt !== null;
  const respond = (status: 'ATTENDING' | 'NOT_ATTENDING') =>
    reserve.mutate(status, {
      onSuccess: (result) => {
        hapticSuccess();
        setWarning(result.warning === 'OUTSTANDING_DEBT');
      },
    });
  const charge = tr.myCharge;
  const fmt = (m: { amountMinor: number; currency: string }) =>
    formatMoney(money(m.amountMinor, m.currency as 'EUR'));

  return (
    <Screen testID="training-detail">
      <View style={{ gap: theme.spacing.sm }}>
        <AppText variant="title1" accessibilityRole="header">
          {tr.title}
        </AppText>
        <Chip
          testID="training-state"
          label={t(`trainings.status.${state.key}`)}
          tone={state.tone}
        />
      </View>

      {tr.status === 'CANCELLED' ? (
        <Banner
          tone="danger"
          message={t('trainings.cancelled', { reason: tr.cancellationReason ?? '' })}
        />
      ) : null}

      <Section>
        <ListRow title={t('trainings.when')} subtitle={range(tr.startsAt, tr.endsAt)} />
        <ListRow title={t('trainings.location')} subtitle={tr.location} />
        <ListRow
          title={t('trainings.places')}
          subtitle={
            tr.spotsLeft === null
              ? t('trainings.unlimited')
              : tr.spotsLeft === 0
                ? t('trainings.full')
                : t('trainings.spotsLeft', { count: tr.spotsLeft })
          }
        />
        <ListRow
          title={t('trainings.yourPrice')}
          subtitle={t(`trainings.priceSource.${tr.myPrice.source}`)}
          trailing={<MoneyText testID="my-price" value={tr.myPrice.price} variant="headline" />}
        />
      </Section>

      {tr.description ? <AppText tone="textSecondary">{tr.description}</AppText> : null}

      {charge ? (
        <Card>
          <AppText variant="headline">{t('trainings.attendanceTitle')}</AppText>
          <AppText testID="my-attendance">
            {t(`trainings.attendance.${tr.myAttendance ?? 'PENDING'}`)}
          </AppText>
          <AppText
            testID="my-charge"
            tone={charge.status === 'REVERSED' ? 'textSecondary' : 'textPrimary'}
          >
            {charge.status === 'REVERSED'
              ? t('trainings.chargeReversed')
              : charge.shortfall.amountMinor > 0
                ? t('trainings.chargedWithDebt', {
                    amount: fmt(charge.unitPrice),
                    debt: fmt(charge.shortfall),
                  })
                : t('trainings.charged', { amount: fmt(charge.unitPrice) })}
          </AppText>
        </Card>
      ) : null}

      {tr.status === 'SCHEDULED' && !tr.finalizedAt ? (
        <AppText variant="footnote" tone="textSecondary">
          {tr.deadlinePassed
            ? t('trainings.deadlinePassed')
            : t('trainings.deadline', { date: dateTime(tr.reservationDeadline) })}
        </AppText>
      ) : null}

      {warning ? (
        <Banner testID="debt-warning" tone="warning" message={t('trainings.debtWarning')} />
      ) : null}
      <FormError message={errorMessage(reserve.error)} />

      {canMutate && !closed ? (
        <View style={{ gap: theme.spacing.sm }}>
          <Button
            testID="reserve-attending"
            label={t('trainings.attend')}
            variant={tr.myReservation === 'ATTENDING' ? 'secondary' : 'primary'}
            loading={reserve.isPending && reserve.variables === 'ATTENDING'}
            disabled={tr.myReservation === 'ATTENDING' || tr.spotsLeft === 0}
            onPress={() => respond('ATTENDING')}
          />
          <Button
            testID="reserve-not-attending"
            label={t('trainings.notAttend')}
            variant="secondary"
            loading={reserve.isPending && reserve.variables === 'NOT_ATTENDING'}
            disabled={tr.myReservation === 'NOT_ATTENDING'}
            onPress={() => respond('NOT_ATTENDING')}
          />
        </View>
      ) : null}
    </Screen>
  );
}
