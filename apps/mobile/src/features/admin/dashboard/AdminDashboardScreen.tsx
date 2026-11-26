import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MoneyDto } from '@tw/contracts';
import { useTranslation } from 'react-i18next';
import { RefreshControl, ScrollView, View } from 'react-native';
import type { AdminTabParamList } from '../../../app/navigation/types';
import { useRefreshOnFocus } from '../../../shared/feedback/feedback';
import { useFormatDate } from '../../../shared/format/date';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { AppText } from '../../../shared/ui/AppText';
import { Card } from '../../../shared/ui/Card';
import { ListRow } from '../../../shared/ui/ListRow';
import { MoneyText } from '../../../shared/ui/MoneyText';
import { Section } from '../../../shared/ui/Section';
import { ErrorState, Skeleton } from '../../../shared/ui/States';
import { SignedAmount } from '../../member/screens/HomeScreen';
import { useTransactionTitle } from '../../member/format';
import { useAdminDashboard } from '../api';

function Kpi({
  label,
  value,
  kind,
  testID,
}: {
  label: string;
  value: MoneyDto | number;
  kind?: 'debt';
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Card style={{ flexBasis: '47%', flexGrow: 1, gap: theme.spacing.xs }}>
      <AppText variant="footnote" tone="textSecondary">
        {label}
      </AppText>
      {typeof value === 'number' ? (
        <AppText testID={testID} variant="title2">
          {value}
        </AppText>
      ) : (
        <MoneyText testID={testID} value={value} variant="title2" {...(kind ? { kind } : {})} />
      )}
    </Card>
  );
}

export function AdminDashboardScreen({
  navigation,
}: BottomTabScreenProps<AdminTabParamList, 'Dashboard'>) {
  const { t } = useTranslation('manage');
  const theme = useTheme();
  const { dateTime } = useFormatDate();
  const txTitle = useTransactionTitle();
  const query = useAdminDashboard();
  useRefreshOnFocus(query.refetch);
  const d = query.data;

  const attention = d
    ? [
        d.needsAttention.trainingsAwaitingFinalization > 0
          ? {
              key: 'finalize',
              label: t('dashboard.awaitingFinalization', {
                count: d.needsAttention.trainingsAwaitingFinalization,
              }),
              onPress: () =>
                navigation.navigate('AdminTrainings', {
                  screen: 'AttendanceQueue',
                  initial: false,
                }),
            }
          : null,
        d.needsAttention.paymentsRequiringReview > 0
          ? {
              key: 'review',
              label: t('dashboard.paymentsReview', {
                count: d.needsAttention.paymentsRequiringReview,
              }),
              onPress: () => navigation.navigate('Finance'),
            }
          : null,
        d.needsAttention.reconciliationIssues
          ? {
              key: 'recon',
              label: t('dashboard.reconciliation', {
                count: d.needsAttention.reconciliationIssues,
              }),
              onPress: () => navigation.navigate('Finance'),
            }
          : null,
      ].filter((x) => x !== null)
    : [];

  return (
    <ScrollView
      testID="admin-dashboard"
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
      }
    >
      {query.isPending ? (
        <Skeleton rows={4} />
      ) : !d ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <Section title={t('dashboard.attention')}>
            {attention.length === 0 ? (
              <ListRow testID="all-good" title={t('dashboard.allGood')} />
            ) : (
              attention.map((a) => (
                <ListRow
                  key={a.key}
                  testID={`attention-${a.key}`}
                  title={a.label}
                  onPress={a.onPress}
                />
              ))
            )}
          </Section>
          <AppText variant="headline">{t('dashboard.period')}</AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md }}>
            <Kpi
              testID="kpi-balances"
              label={t('dashboard.balances')}
              value={d.totalWalletBalances}
            />
            <Kpi
              testID="kpi-debt"
              label={t('dashboard.debt')}
              value={d.outstandingDebt}
              kind="debt"
            />
            <Kpi label={t('dashboard.revenue')} value={d.trainingRevenue} />
            <Kpi label={t('dashboard.online')} value={d.onlineTopUps} />
            <Kpi label={t('dashboard.cash')} value={d.cashPayments} />
            <Kpi label={t('dashboard.members')} value={d.users.active} />
            <Kpi label={t('dashboard.upcoming')} value={d.upcomingTrainings} />
          </View>
          <Section title={t('dashboard.recent')}>
            {d.recentTransactions.slice(0, 8).map((tx) => (
              <ListRow
                key={tx.id}
                title={txTitle(tx)}
                subtitle={dateTime(tx.createdAt)}
                trailing={
                  <SignedAmount
                    minor={tx.walletDelta.amountMinor}
                    currency={tx.walletDelta.currency}
                    debtMinor={tx.debtDelta.amountMinor}
                  />
                }
                onPress={() =>
                  navigation.navigate('Users', {
                    screen: 'UserDetail',
                    params: { userId: tx.userId },
                    initial: false,
                  })
                }
              />
            ))}
          </Section>
        </>
      )}
    </ScrollView>
  );
}
