import { useTranslation } from 'react-i18next';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSessionUser } from '../../../shared/auth/session';
import { useCanMutate, useViewAsSession } from '../../../shared/auth/viewAs';
import { useRefreshOnFocus } from '../../../shared/feedback/feedback';
import { useFormatDate } from '../../../shared/format/date';
import { useFormatMoney } from '../../../shared/format/money';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { Card } from '../../../shared/ui/Card';
import { ListRow } from '../../../shared/ui/ListRow';
import { MoneyText } from '../../../shared/ui/MoneyText';
import { Section } from '../../../shared/ui/Section';
import { Banner, Chip, ErrorState, Skeleton } from '../../../shared/ui/States';
import { money } from '@tw/money';
import { usePushPermission } from '../../../shared/push/usePush';
import { usePreferencesStore } from '../../../stores/preferences.store';
import { useMyTrainings, useTransactions, useUnreadCount, useWallet } from '../api';
import { trainingState, useTransactionTitle } from '../format';
import type { HomeScreenProps } from '../navigation';

/** Wallet first: balance and debt are what members check most (docs/02-architecture.md §4). */
export function HomeScreen({ navigation }: HomeScreenProps) {
  const { t } = useTranslation('member');
  const theme = useTheme();
  const self = useSessionUser();
  const viewed = useViewAsSession();
  const canMutate = useCanMutate();
  const formatMoney = useFormatMoney();
  const { dateTime } = useFormatDate();
  const txTitle = useTransactionTitle();
  const wallet = useWallet();
  const trainings = useMyTrainings('upcoming');
  const transactions = useTransactions();
  const unread = useUnreadCount();

  const refetchAll = () =>
    Promise.all([wallet.refetch(), trainings.refetch(), transactions.refetch(), unread.refetch()]);
  useRefreshOnFocus(refetchAll);

  const firstName = viewed?.subject.firstName ?? self?.firstName ?? '';
  const next = trainings.data?.pages.flatMap((p) => p.data).find((tr) => tr.status !== 'CANCELLED');
  const recent = transactions.data?.pages[0]?.data.slice(0, 3) ?? [];
  const unreadCount = unread.data?.unread ?? 0;

  return (
    <ScrollView
      testID="home-screen"
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl refreshing={wallet.isRefetching} onRefresh={() => void refetchAll()} />
      }
    >
      <AppText variant="title1" accessibilityRole="header">
        {t('home.greeting', { name: firstName })}
      </AppText>

      {wallet.isPending ? (
        <Skeleton rows={1} />
      ) : wallet.error ? (
        <ErrorState error={wallet.error} onRetry={() => void wallet.refetch()} />
      ) : wallet.data ? (
        <Card>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
            }}
          >
            <View style={{ gap: theme.spacing.xxs }}>
              <AppText variant="footnote" tone="textSecondary">
                {t('home.balance')}
              </AppText>
              <MoneyText testID="home-balance" value={wallet.data.balance} variant="largeTitle" />
            </View>
            {wallet.data.debt.amountMinor > 0 ? (
              <View style={{ alignItems: 'flex-end', gap: theme.spacing.xxs }}>
                <AppText variant="footnote" tone="textSecondary">
                  {t('home.debt')}
                </AppText>
                <MoneyText
                  testID="home-debt"
                  value={wallet.data.debt}
                  kind="debt"
                  variant="title2"
                />
              </View>
            ) : null}
          </View>
          {canMutate ? (
            <Button
              testID="home-top-up"
              label={t('home.topUp')}
              onPress={() => navigation.navigate('Wallet', { screen: 'TopUp' })}
            />
          ) : null}
        </Card>
      ) : null}

      {canMutate ? <PushPrompt /> : null}

      {wallet.data && wallet.data.debt.amountMinor > 0 ? (
        <Banner
          testID="debt-banner"
          tone="warning"
          message={t('home.debtBanner', {
            amount: formatMoney(money(wallet.data.debt.amountMinor, wallet.data.debt.currency)),
          })}
        />
      ) : null}

      <Section title={t('home.nextTraining')}>
        {trainings.isPending ? (
          <Skeleton rows={1} />
        ) : next ? (
          <ListRow
            testID="next-training"
            title={next.title}
            subtitle={`${dateTime(next.startsAt)} · ${next.location}`}
            trailing={
              <Chip
                label={t(`trainings.status.${trainingState(next).key}`)}
                tone={trainingState(next).tone}
              />
            }
            onPress={() =>
              navigation.navigate('Trainings', {
                screen: 'TrainingDetail',
                params: { trainingId: next.id },
                initial: false,
              })
            }
          />
        ) : (
          <ListRow title={t('home.noTraining')} />
        )}
      </Section>

      {unreadCount > 0 ? (
        <Section>
          <ListRow
            testID="home-unread"
            title={t('home.unread', { count: unreadCount })}
            onPress={() => navigation.navigate('Notifications')}
          />
        </Section>
      ) : null}

      <Section title={t('home.recent')}>
        {recent.length === 0 ? (
          <ListRow title={t('home.noActivity')} />
        ) : (
          recent.map((tx) => (
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
                navigation.navigate('Wallet', {
                  screen: 'TransactionDetail',
                  params: { transactionId: tx.id },
                  initial: false,
                })
              }
            />
          ))
        )}
        {recent.length > 0 ? (
          <ListRow
            title={t('home.seeAll')}
            onPress={() => navigation.navigate('Wallet', { screen: 'WalletHome' })}
          />
        ) : null}
      </Section>
    </ScrollView>
  );
}

/** Asks for notification permission in context, once, until the member decides. */
function PushPrompt() {
  const { t } = useTranslation('member');
  const theme = useTheme();
  const { status, request } = usePushPermission();
  const dismissed = usePreferencesStore((s) => s.pushPromptDismissed);
  const dismiss = usePreferencesStore((s) => s.dismissPushPrompt);
  if (status !== 'undetermined' || dismissed) return null;
  return (
    <Card testID="push-prompt">
      <AppText variant="headline">{t('home.pushPrompt.title')}</AppText>
      <AppText tone="textSecondary">{t('home.pushPrompt.body')}</AppText>
      <View style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'center' }}>
        <Button
          testID="push-prompt-enable"
          label={t('home.pushPrompt.enable')}
          loading={request.isPending}
          onPress={() => request.mutate()}
        />
        <Button
          testID="push-prompt-dismiss"
          variant="link"
          label={t('home.pushPrompt.later')}
          onPress={dismiss}
        />
      </View>
    </Card>
  );
}

/** "+€25.00" in green for credits, "−€10.00" for debits; a pure debt change shows the debt. */
export function SignedAmount({
  minor,
  currency,
  debtMinor = 0,
}: {
  minor: number;
  currency: string;
  debtMinor?: number;
}) {
  const formatMoney = useFormatMoney();
  const value = minor !== 0 ? minor : -debtMinor;
  const text = `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatMoney(money(Math.abs(value), currency as 'EUR'))}`;
  return (
    <AppText
      variant="subhead"
      tone={value > 0 ? 'success' : 'textPrimary'}
      style={{ fontVariant: ['tabular-nums'] }}
    >
      {text}
    </AppText>
  );
}
