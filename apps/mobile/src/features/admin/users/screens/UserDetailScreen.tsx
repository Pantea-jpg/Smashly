import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';
import { useIntlLocale } from '../../../../shared/i18n/I18nProvider';
import { useErrorMessage } from '../../../../shared/i18n/useErrorMessage';
import { useTheme } from '../../../../shared/theme/ThemeProvider';
import { AppText } from '../../../../shared/ui/AppText';
import { Avatar } from '../../../../shared/ui/Avatar';
import { Button } from '../../../../shared/ui/Button';
import { Card } from '../../../../shared/ui/Card';
import { FormError } from '../../../../shared/ui/FormScreen';
import { ListRow } from '../../../../shared/ui/ListRow';
import { MoneyText } from '../../../../shared/ui/MoneyText';
import { Screen } from '../../../../shared/ui/Screen';
import { Section } from '../../../../shared/ui/Section';
import { StatusPill } from '../../../../shared/ui/StatusPill';
import { useFormatDate } from '../../../../shared/format/date';
import { useTransactionTitle } from '../../../member/format';
import { SignedAmount } from '../../../member/screens/HomeScreen';
import { useUserTrainings, useUserTransactions } from '../../api';
import { useAdminUser, useStartViewAs } from '../api';
import type { UsersScreenProps } from '../navigation';

/** Wallet actions plus the latest ledger entries and trainings of one member. */
function UserMoneySection({
  userId,
  name,
  navigation,
}: {
  userId: string;
  name: string;
  navigation: UsersScreenProps<'UserDetail'>['navigation'];
}) {
  const { t } = useTranslation('manage');
  const { t: tm } = useTranslation('member');
  const { dateTime } = useFormatDate();
  const txTitle = useTransactionTitle();
  const transactions = useUserTransactions(userId);
  const trainings = useUserTrainings(userId);
  const recent = transactions.data?.pages[0]?.data.slice(0, 3) ?? [];
  return (
    <>
      <Button
        testID="record-cash"
        label={t('money.cash')}
        onPress={() => navigation.navigate('CashPayment', { userId, name })}
      />
      <Button
        testID="open-adjustment"
        variant="secondary"
        label={t('money.adjust')}
        onPress={() => navigation.navigate('Adjustment', { userId, name })}
      />
      <Button
        testID="open-refund"
        variant="secondary"
        label={t('money.refund')}
        onPress={() => navigation.navigate('Refund', { userId, name })}
      />
      <Section title={t('money.transactions')}>
        {recent.length === 0 ? (
          <ListRow title={tm('wallet.empty')} />
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
            />
          ))
        )}
        <ListRow
          testID="all-user-transactions"
          title={tm('home.seeAll')}
          onPress={() => navigation.navigate('UserTransactions', { userId })}
        />
      </Section>
      <Section title={t('money.trainings')}>
        {(trainings.data?.data ?? []).length === 0 ? (
          <ListRow title={t('money.noTrainings')} />
        ) : (
          trainings.data?.data.map((h) => (
            <ListRow
              key={h.training.id}
              title={h.training.title}
              subtitle={`${dateTime(h.training.startsAt)} · ${tm(`trainings.attendance.${h.attendance ?? 'PENDING'}`)}`}
              trailing={
                h.charge && h.charge.status === 'ACTIVE' ? (
                  <MoneyText value={h.charge.unitPrice} variant="subhead" />
                ) : undefined
              }
            />
          ))
        )}
      </Section>
    </>
  );
}

export function UserDetailScreen({ route, navigation }: UsersScreenProps<'UserDetail'>) {
  const { userId } = route.params;
  const { t } = useTranslation('admin');
  const { t: ts } = useTranslation('settings');
  const theme = useTheme();
  const locale = useIntlLocale();
  const errorMessage = useErrorMessage();
  const user = useAdminUser(userId);
  const viewAs = useStartViewAs();

  if (user.isPending) {
    return (
      <Screen>
        <ActivityIndicator />
      </Screen>
    );
  }
  if (!user.data) {
    return (
      <Screen>
        <FormError message={errorMessage(user.error)} />
      </Screen>
    );
  }

  const u = user.data;
  const name = `${u.firstName} ${u.lastName}`.trim() || u.email;
  const date = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso))
      : t('detail.never');
  const isDeleted = u.deletedAt !== null;

  return (
    <Screen testID="user-detail-screen">
      <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        <Avatar url={u.avatarUrl} firstName={u.firstName} lastName={u.lastName} size={80} />
        <AppText variant="title2">{name}</AppText>
        <StatusPill status={u.status} />
        {isDeleted ? <AppText tone="danger">{t('detail.deleted')}</AppText> : null}
      </View>

      {u.balance && u.debt ? (
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <View style={{ gap: theme.spacing.xxs }}>
              <AppText variant="footnote" tone="textSecondary">
                {t('detail.balance')}
              </AppText>
              <MoneyText testID="user-balance" value={u.balance} variant="title2" />
            </View>
            <View style={{ gap: theme.spacing.xxs, alignItems: 'flex-end' }}>
              <AppText variant="footnote" tone="textSecondary">
                {t('detail.debt')}
              </AppText>
              <MoneyText value={u.debt} kind="debt" variant="title2" />
            </View>
          </View>
        </Card>
      ) : null}

      <Section>
        <ListRow
          title={t('detail.email')}
          subtitle={u.emailVerified ? u.email : `${u.email} · ${t('detail.unverified')}`}
        />
        <ListRow title={t('detail.phone')} subtitle={u.phone ?? '—'} />
        <ListRow title={t('detail.language')} subtitle={ts(`language.${u.preferredLanguage}`)} />
        <ListRow title={t('detail.registered')} subtitle={date(u.createdAt)} />
        <ListRow title={t('detail.lastLogin')} subtitle={date(u.lastLoginAt)} />
      </Section>

      {u.role === 'USER' && !isDeleted ? (
        <UserMoneySection userId={u.id} name={name} navigation={navigation} />
      ) : null}

      <FormError message={errorMessage(viewAs.error)} />
      {!isDeleted && u.role === 'USER' ? (
        <Button
          testID="view-as-user"
          label={t('actions.viewAs')}
          loading={viewAs.isPending}
          onPress={() => viewAs.mutate(u.id)}
        />
      ) : null}
      {!isDeleted && u.status === 'PENDING_APPROVAL' ? (
        <Button
          testID="approve-user"
          variant="secondary"
          label={t('actions.approve')}
          onPress={() =>
            navigation.navigate('ChangeUserStatus', { userId: u.id, status: 'ACTIVE' })
          }
        />
      ) : null}
      {!isDeleted && u.status === 'INACTIVE' ? (
        <Button
          testID="activate-user"
          variant="secondary"
          label={t('actions.activate')}
          onPress={() =>
            navigation.navigate('ChangeUserStatus', { userId: u.id, status: 'ACTIVE' })
          }
        />
      ) : null}
      {!isDeleted && u.status === 'ACTIVE' ? (
        <Button
          testID="deactivate-user"
          variant="destructive"
          label={t('actions.deactivate')}
          onPress={() =>
            navigation.navigate('ChangeUserStatus', { userId: u.id, status: 'INACTIVE' })
          }
        />
      ) : null}
    </Screen>
  );
}
