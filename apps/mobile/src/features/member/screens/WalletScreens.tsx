import { money } from '@tw/money';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useCanMutate } from '../../../shared/auth/viewAs';
import { useRefreshOnFocus } from '../../../shared/feedback/feedback';
import { useFormatDate } from '../../../shared/format/date';
import { useFormatMoney } from '../../../shared/format/money';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { Card } from '../../../shared/ui/Card';
import { ListRow } from '../../../shared/ui/ListRow';
import { ListScreen } from '../../../shared/ui/ListScreen';
import { MoneyText } from '../../../shared/ui/MoneyText';
import { Screen } from '../../../shared/ui/Screen';
import { Section } from '../../../shared/ui/Section';
import { Banner, Chip, ErrorState, Skeleton } from '../../../shared/ui/States';
import { useDebts, useTransaction, useTransactions, useWallet } from '../api';
import { useTransactionTitle } from '../format';
import type { WalletScreenProps } from '../navigation';
import { SignedAmount } from './HomeScreen';

export function WalletScreen({ navigation }: WalletScreenProps<'WalletHome'>) {
  const { t } = useTranslation('member');
  const theme = useTheme();
  const canMutate = useCanMutate();
  const { dateTime } = useFormatDate();
  const txTitle = useTransactionTitle();
  const wallet = useWallet();
  const debts = useDebts();
  const transactions = useTransactions();
  const refetchAll = () => Promise.all([wallet.refetch(), debts.refetch(), transactions.refetch()]);
  useRefreshOnFocus(refetchAll);
  const items = transactions.data?.pages.flatMap((p) => p.data) ?? [];
  const openDebts = (debts.data ?? []).filter((d) => d.status === 'OPEN');

  const header = (
    <>
      {wallet.isPending ? (
        <Skeleton rows={1} />
      ) : wallet.error ? (
        <ErrorState error={wallet.error} onRetry={() => void wallet.refetch()} />
      ) : wallet.data ? (
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <View style={{ gap: theme.spacing.xxs }}>
              <AppText variant="footnote" tone="textSecondary">
                {t('wallet.balance')}
              </AppText>
              <MoneyText testID="wallet-balance" value={wallet.data.balance} variant="largeTitle" />
            </View>
            <View style={{ gap: theme.spacing.xxs, alignItems: 'flex-end' }}>
              <AppText variant="footnote" tone="textSecondary">
                {t('wallet.debt')}
              </AppText>
              <MoneyText
                testID="wallet-debt"
                value={wallet.data.debt}
                kind="debt"
                variant="title2"
              />
            </View>
          </View>
          {canMutate && wallet.data.canTopUp ? (
            <Button
              testID="wallet-top-up"
              label={t('wallet.topUp')}
              onPress={() => navigation.navigate('TopUp')}
            />
          ) : null}
          {canMutate && !wallet.data.canTopUp ? (
            <Banner tone="accent" message={t('wallet.verifyToTopUp')} />
          ) : null}
        </Card>
      ) : null}
      {openDebts.length > 0 ? (
        <Section title={t('wallet.openDebts')}>
          {openDebts.map((d) => (
            <ListRow
              key={d.id}
              title={
                d.source === 'TRAINING_CHARGE'
                  ? t('wallet.type.TRAINING_PAYMENT')
                  : t('wallet.type.REFUND')
              }
              subtitle={dateTime(d.createdAt)}
              trailing={<MoneyText value={d.outstandingAmount} kind="debt" variant="subhead" />}
            />
          ))}
        </Section>
      ) : null}
      <AppText variant="headline">{t('wallet.transactions')}</AppText>
    </>
  );

  return (
    <ListScreen
      testID="wallet-screen"
      header={header}
      data={items}
      keyExtractor={(tx) => tx.id}
      isPending={transactions.isPending}
      error={transactions.error}
      emptyMessage={t('wallet.empty')}
      refreshing={transactions.isRefetching && !transactions.isFetchingNextPage}
      onRefresh={refetchAll}
      onEndReached={() =>
        transactions.hasNextPage && !transactions.isFetchingNextPage
          ? transactions.fetchNextPage()
          : undefined
      }
      renderItem={(tx) => (
        <ListRow
          testID={`tx-${tx.id}`}
          title={txTitle(tx)}
          subtitle={`${dateTime(tx.createdAt)}${tx.status === 'REVERSED' ? ` · ${t('wallet.reversed')}` : ''}`}
          trailing={
            <SignedAmount
              minor={tx.walletDelta.amountMinor}
              currency={tx.walletDelta.currency}
              debtMinor={tx.debtDelta.amountMinor}
            />
          }
          onPress={() => navigation.navigate('TransactionDetail', { transactionId: tx.id })}
        />
      )}
    />
  );
}

export function TransactionDetailScreen({ route }: WalletScreenProps<'TransactionDetail'>) {
  const { t } = useTranslation('member');
  const theme = useTheme();
  const { dateTime } = useFormatDate();
  const formatMoney = useFormatMoney();
  const txTitle = useTransactionTitle();
  const tx = useTransaction(route.params.transactionId);

  if (tx.isPending) {
    return (
      <Screen>
        <Skeleton rows={2} />
      </Screen>
    );
  }
  if (!tx.data) {
    return (
      <Screen>
        <ErrorState error={tx.error} onRetry={() => void tx.refetch()} />
      </Screen>
    );
  }
  const d = tx.data;
  const signed = (m: { amountMinor: number; currency: string }) =>
    `${m.amountMinor > 0 ? '+' : m.amountMinor < 0 ? '−' : ''}${formatMoney(money(Math.abs(m.amountMinor), m.currency as 'EUR'))}`;

  return (
    <Screen testID="transaction-detail">
      <View style={{ gap: theme.spacing.sm }}>
        <AppText variant="title2">{txTitle(d)}</AppText>
        <MoneyText value={d.amount} variant="largeTitle" />
        {d.status === 'REVERSED' ? <Chip label={t('wallet.reversed')} tone="warning" /> : null}
      </View>
      <Section>
        <ListRow title={t('wallet.detail.date')} subtitle={dateTime(d.createdAt)} />
        <ListRow
          title={t('wallet.detail.method')}
          subtitle={t(`wallet.method.${d.paymentMethod}`)}
        />
        <ListRow title={t('wallet.detail.walletChange')} subtitle={signed(d.walletDelta)} />
        {d.debtDelta.amountMinor !== 0 ? (
          <ListRow title={t('wallet.detail.debtChange')} subtitle={signed(d.debtDelta)} />
        ) : null}
        <ListRow
          title={t('wallet.detail.balanceAfter')}
          trailing={<MoneyText value={d.balanceAfter} variant="subhead" />}
        />
        <ListRow
          title={t('wallet.detail.debtAfter')}
          trailing={<MoneyText value={d.debtAfter} kind="debt" variant="subhead" />}
        />
        {d.reason ? <ListRow title={t('wallet.detail.reason')} subtitle={d.reason} /> : null}
      </Section>
      {d.reversedByTransactionId ? (
        <Banner tone="accent" message={t('wallet.detail.reversedLater')} />
      ) : null}
    </Screen>
  );
}
