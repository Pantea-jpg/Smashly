import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import type { AdminTabParamList } from '../../../app/navigation/types';
import { useRefreshOnFocus } from '../../../shared/feedback/feedback';
import { useFormatDate } from '../../../shared/format/date';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { AppText } from '../../../shared/ui/AppText';
import { Card } from '../../../shared/ui/Card';
import { ListRow } from '../../../shared/ui/ListRow';
import { ListScreen } from '../../../shared/ui/ListScreen';
import { MoneyText } from '../../../shared/ui/MoneyText';
import { SegmentedControl } from '../../../shared/ui/SegmentedControl';
import { Skeleton } from '../../../shared/ui/States';
import { TextField } from '../../../shared/ui/TextField';
import { useTransactionTitle } from '../../member/format';
import { SignedAmount } from '../../member/screens/HomeScreen';
import { useAdminTransactions, useAdminWallets, useFinancialSummary } from '../api';

function SummaryCard() {
  const { t } = useTranslation('manage');
  const theme = useTheme();
  const summary = useFinancialSummary();
  if (!summary.data) return <Skeleton rows={1} />;
  const s = summary.data;
  const row = (label: string, value: typeof s.refunds, kind?: 'debt') => (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <AppText tone="textSecondary">{label}</AppText>
      <MoneyText value={value} variant="headline" {...(kind ? { kind } : {})} />
    </View>
  );
  return (
    <Card>
      <AppText variant="headline">{t('finance.summary')}</AppText>
      <View style={{ gap: theme.spacing.xs }}>
        {row(t('finance.charged'), s.trainingRevenue.charged)}
        {row(t('finance.collected'), s.trainingRevenue.collected)}
        {row(t('finance.outstanding'), s.trainingRevenue.outstanding, 'debt')}
        {row(t('finance.online'), s.topUps.online)}
        {row(t('finance.cash'), s.topUps.cash)}
        {row(t('finance.refunds'), s.refunds)}
      </View>
    </Card>
  );
}

export function FinanceScreen({ navigation }: BottomTabScreenProps<AdminTabParamList, 'Finance'>) {
  const { t } = useTranslation('manage');
  const { dateTime } = useFormatDate();
  const txTitle = useTransactionTitle();
  const [tab, setTab] = useState<'wallets' | 'transactions'>('wallets');
  const [q, setQ] = useState('');
  const wallets = useAdminWallets(q);
  const transactions = useAdminTransactions();
  useRefreshOnFocus(tab === 'wallets' ? wallets.refetch : transactions.refetch);
  const openUser = (userId: string) =>
    navigation.navigate('Users', { screen: 'UserDetail', params: { userId }, initial: false });

  const header = (
    <>
      <SummaryCard />
      <SegmentedControl
        testID="finance-tab"
        accessibilityLabel={t('finance.wallets')}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'wallets', label: t('finance.wallets') },
          { value: 'transactions', label: t('finance.transactions') },
        ]}
      />
      {tab === 'wallets' ? (
        <TextField
          testID="wallet-search"
          label={t('finance.search')}
          value={q}
          onChangeText={setQ}
          autoCorrect={false}
        />
      ) : null}
    </>
  );

  if (tab === 'wallets') {
    const items = wallets.data?.pages.flatMap((p) => p.data) ?? [];
    return (
      <ListScreen
        testID="finance-wallets"
        header={header}
        data={items}
        keyExtractor={(w) => w.id}
        isPending={wallets.isPending}
        error={wallets.error}
        emptyMessage={t('finance.empty')}
        refreshing={wallets.isRefetching && !wallets.isFetchingNextPage}
        onRefresh={wallets.refetch}
        onEndReached={() =>
          wallets.hasNextPage && !wallets.isFetchingNextPage ? wallets.fetchNextPage() : undefined
        }
        renderItem={(w) => (
          <ListRow
            testID={`wallet-${w.userId}`}
            title={`${w.firstName} ${w.lastName}`.trim() || w.email}
            subtitle={w.email}
            trailing={
              w.debt.amountMinor > 0 ? (
                <MoneyText value={w.debt} kind="debt" variant="subhead" />
              ) : (
                <MoneyText value={w.balance} variant="subhead" />
              )
            }
            onPress={() => openUser(w.userId)}
          />
        )}
      />
    );
  }
  const items = transactions.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <ListScreen
      testID="finance-transactions"
      header={header}
      data={items}
      keyExtractor={(tx) => tx.id}
      isPending={transactions.isPending}
      error={transactions.error}
      emptyMessage={t('finance.empty')}
      refreshing={transactions.isRefetching && !transactions.isFetchingNextPage}
      onRefresh={transactions.refetch}
      onEndReached={() =>
        transactions.hasNextPage && !transactions.isFetchingNextPage
          ? transactions.fetchNextPage()
          : undefined
      }
      renderItem={(tx) => (
        <ListRow
          title={txTitle(tx)}
          subtitle={dateTime(tx.createdAt)}
          trailing={
            <SignedAmount
              minor={tx.walletDelta.amountMinor}
              currency={tx.walletDelta.currency}
              debtMinor={tx.debtDelta.amountMinor}
            />
          }
          onPress={() => openUser(tx.userId)}
        />
      )}
    />
  );
}
