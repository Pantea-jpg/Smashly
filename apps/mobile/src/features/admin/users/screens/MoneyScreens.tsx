import { money } from '@tw/money';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIdempotencyKey } from '../../../../shared/api/idempotency';
import { confirm, hapticSuccess } from '../../../../shared/feedback/feedback';
import { parseAmountToMinor } from '../../../../shared/format/amount';
import { useFormatDate } from '../../../../shared/format/date';
import { useFormatMoney } from '../../../../shared/format/money';
import { useErrorMessage } from '../../../../shared/i18n/useErrorMessage';
import { AppText } from '../../../../shared/ui/AppText';
import { Button } from '../../../../shared/ui/Button';
import { FormError } from '../../../../shared/ui/FormScreen';
import { ListRow } from '../../../../shared/ui/ListRow';
import { ListScreen } from '../../../../shared/ui/ListScreen';
import { Screen } from '../../../../shared/ui/Screen';
import { SegmentedControl } from '../../../../shared/ui/SegmentedControl';
import { Banner } from '../../../../shared/ui/States';
import { TextField } from '../../../../shared/ui/TextField';
import { useTransactionTitle } from '../../../member/format';
import { SignedAmount } from '../../../member/screens/HomeScreen';
import { Ionicons } from '@expo/vector-icons';
import {
  useAdjustment,
  useCashPayment,
  useRefund,
  useReversal,
  useUserPayments,
  useUserTransactions,
} from '../../api';
import { useAdminUser } from '../api';
import type { UsersScreenProps } from '../navigation';

/** Cash handed to an admin: amount → native confirmation → ledger (idempotent). */
export function CashPaymentScreen({ route, navigation }: UsersScreenProps<'CashPayment'>) {
  const { userId, name } = route.params;
  const { t } = useTranslation('manage');
  const { t: tc } = useTranslation('common');
  const formatMoney = useFormatMoney();
  const errorMessage = useErrorMessage();
  const cash = useCashPayment(userId);
  const idempotency = useIdempotencyKey();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const minor = parseAmountToMinor(amount);
  const valid = minor !== null && minor > 0;

  const submit = async () => {
    if (!valid) return;
    const ok = await confirm({
      title: t('money.cashConfirmTitle', { amount: formatMoney(money(minor)), name }),
      message: t('money.cashConfirmBody'),
      confirmLabel: tc('actions.confirm'),
      cancelLabel: tc('actions.cancel'),
    });
    if (!ok) return;
    cash.mutate(
      { amountMinor: minor, description: note.trim(), headers: idempotency.headers },
      {
        onSuccess: () => {
          hapticSuccess();
          navigation.goBack();
        },
      },
    );
  };

  return (
    <Screen testID="cash-payment-screen">
      <AppText variant="title2">{name}</AppText>
      <TextField
        testID="cash-amount"
        label={t('money.cashAmount')}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        error={amount && !valid ? t('money.invalidAmount') : undefined}
      />
      <TextField
        testID="cash-note"
        label={t('money.cashNote')}
        value={note}
        onChangeText={setNote}
      />
      <FormError message={errorMessage(cash.error)} />
      <Button
        testID="submit-cash"
        label={t('money.cash')}
        disabled={!valid}
        loading={cash.isPending}
        onPress={() => void submit()}
      />
    </Screen>
  );
}

export function AdjustmentScreen({ route, navigation }: UsersScreenProps<'Adjustment'>) {
  const { userId, name } = route.params;
  const { t } = useTranslation('manage');
  const { t: tc } = useTranslation('common');
  const formatMoney = useFormatMoney();
  const errorMessage = useErrorMessage();
  const adjust = useAdjustment(userId);
  const idempotency = useIdempotencyKey();
  const [kind, setKind] = useState<'CREDIT' | 'DEBIT' | 'DEBT_WAIVER'>('CREDIT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const minor = parseAmountToMinor(amount);
  const valid = minor !== null && minor > 0 && reason.trim().length >= 3;

  const submit = async () => {
    if (!valid || minor === null) return;
    const ok = await confirm({
      title: t('money.adjustConfirmTitle', {
        kind: t(`money.adjustKind.${kind}`),
        amount: formatMoney(money(minor)),
      }),
      message: name,
      confirmLabel: tc('actions.confirm'),
      cancelLabel: tc('actions.cancel'),
    });
    if (!ok) return;
    adjust.mutate(
      { kind, amountMinor: minor, reason: reason.trim(), headers: idempotency.headers },
      {
        onSuccess: () => {
          hapticSuccess();
          navigation.goBack();
        },
      },
    );
  };

  return (
    <Screen testID="adjustment-screen">
      <AppText variant="title2">{name}</AppText>
      <SegmentedControl
        testID="adjust-kind"
        accessibilityLabel={t('money.adjust')}
        value={kind}
        onChange={setKind}
        options={[
          { value: 'CREDIT', label: t('money.adjustKind.CREDIT') },
          { value: 'DEBIT', label: t('money.adjustKind.DEBIT') },
          { value: 'DEBT_WAIVER', label: t('money.adjustKind.DEBT_WAIVER') },
        ]}
      />
      <TextField
        testID="adjust-amount"
        label={t('money.amount')}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />
      <TextField
        testID="adjust-reason"
        label={t('money.reason')}
        value={reason}
        onChangeText={setReason}
        multiline
      />
      <FormError message={errorMessage(adjust.error)} />
      <Button
        testID="submit-adjustment"
        label={t('money.adjust')}
        disabled={!valid}
        loading={adjust.isPending}
        onPress={() => void submit()}
      />
    </Screen>
  );
}

/**
 * D17: pay unused balance back, in cash or to the card of an online top-up. Only the wallet
 * balance can be refunded (never debt), and a card refund at most what is left of that top-up.
 * The server enforces both; the screen shows the limits so the admin does not hit them.
 */
export function RefundScreen({ route, navigation }: UsersScreenProps<'Refund'>) {
  const { userId, name } = route.params;
  const { t } = useTranslation('manage');
  const { t: tc } = useTranslation('common');
  const { dateTime } = useFormatDate();
  const formatMoney = useFormatMoney();
  const errorMessage = useErrorMessage();
  const user = useAdminUser(userId);
  const payments = useUserPayments(userId);
  const refund = useRefund(userId);
  const idempotency = useIdempotencyKey();
  const [method, setMethod] = useState<'CASH' | 'STRIPE'>('CASH');
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const balance = user.data?.balance?.amountMinor ?? 0;
  const refundable = (payments.data ?? [])
    .filter((p) => p.status === 'SUCCEEDED' || p.status === 'PARTIALLY_REFUNDED')
    .map((p) => ({ ...p, leftMinor: p.amount.amountMinor - p.refundedAmount.amountMinor }))
    .filter((p) => p.leftMinor > 0);
  const chosen = refundable.find((p) => p.id === paymentId) ?? null;
  const minor = parseAmountToMinor(amount);
  const limit = method === 'STRIPE' && chosen ? Math.min(balance, chosen.leftMinor) : balance;
  const valid =
    minor !== null &&
    minor > 0 &&
    minor <= limit &&
    reason.trim().length >= 3 &&
    (method === 'CASH' || chosen !== null);

  const submit = async () => {
    if (!valid || minor === null) return;
    const ok = await confirm({
      title: t('money.refundConfirmTitle', { amount: formatMoney(money(minor)), name }),
      message: method === 'CASH' ? t('money.refundConfirmCash') : t('money.refundConfirmCard'),
      confirmLabel: tc('actions.confirm'),
      cancelLabel: tc('actions.cancel'),
    });
    if (!ok) return;
    refund.mutate(
      {
        method,
        amountMinor: minor,
        reason: reason.trim(),
        ...(method === 'STRIPE' && chosen ? { paymentId: chosen.id } : {}),
        headers: idempotency.headers,
      },
      {
        onSuccess: () => {
          hapticSuccess();
          navigation.goBack();
        },
      },
    );
  };

  return (
    <Screen testID="refund-screen">
      <AppText variant="title2">{name}</AppText>
      <AppText testID="refund-available" tone="textSecondary">
        {t('money.refundAvailable', { amount: formatMoney(money(balance)) })}
      </AppText>
      <SegmentedControl
        testID="refund-method"
        accessibilityLabel={t('money.refund')}
        value={method}
        onChange={setMethod}
        options={[
          { value: 'CASH', label: t('money.refundMethod.CASH') },
          { value: 'STRIPE', label: t('money.refundMethod.STRIPE') },
        ]}
      />
      {method === 'STRIPE' ? (
        refundable.length === 0 ? (
          <Banner tone="accent" message={t('money.refundNoPayments')} />
        ) : (
          <>
            <AppText variant="headline">{t('money.refundChoosePayment')}</AppText>
            {refundable.map((p) => (
              <ListRow
                key={p.id}
                testID={`refund-payment-${p.id}`}
                title={formatMoney(p.amount)}
                subtitle={`${dateTime(p.succeededAt ?? p.createdAt)} · ${t(
                  'money.refundRefundable',
                  {
                    amount: formatMoney(money(p.leftMinor)),
                  },
                )}`}
                trailing={
                  p.id === paymentId ? <Ionicons name="checkmark-circle" size={22} /> : undefined
                }
                onPress={() => setPaymentId(p.id)}
              />
            ))}
          </>
        )
      ) : null}
      <TextField
        testID="refund-amount"
        label={t('money.amount')}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />
      <TextField
        testID="refund-reason"
        label={t('money.reason')}
        value={reason}
        onChangeText={setReason}
        multiline
      />
      <FormError message={errorMessage(refund.error)} />
      <Button
        testID="submit-refund"
        variant="destructive"
        label={t('money.refund')}
        disabled={!valid}
        loading={refund.isPending}
        onPress={() => void submit()}
      />
    </Screen>
  );
}

/** The member's ledger, newest first; cash entries, adjustments and cash refunds can be reversed. */
export function UserTransactionsScreen({
  route,
  navigation,
}: UsersScreenProps<'UserTransactions'>) {
  const { userId } = route.params;
  const { t } = useTranslation('manage');
  const { t: tw } = useTranslation('member');
  const { dateTime } = useFormatDate();
  const txTitle = useTransactionTitle();
  const query = useUserTransactions(userId);
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];
  const reversible = (tx: (typeof items)[number]) =>
    tx.status === 'POSTED' &&
    (tx.type === 'CASH_TOP_UP' ||
      (tx.type === 'ADJUSTMENT' && tx.debtDelta.amountMinor === 0 && tx.paymentId === null) ||
      (tx.type === 'REFUND' && tx.paymentMethod === 'CASH'));
  return (
    <ListScreen
      testID="user-transactions"
      data={items}
      keyExtractor={(tx) => tx.id}
      isPending={query.isPending}
      error={query.error}
      emptyMessage={tw('wallet.empty')}
      refreshing={query.isRefetching && !query.isFetchingNextPage}
      onRefresh={query.refetch}
      onEndReached={() =>
        query.hasNextPage && !query.isFetchingNextPage ? query.fetchNextPage() : undefined
      }
      renderItem={(tx) => (
        <ListRow
          testID={`user-tx-${tx.id}`}
          title={txTitle(tx)}
          subtitle={`${dateTime(tx.createdAt)}${tx.status === 'REVERSED' ? ` · ${tw('wallet.reversed')}` : ''}`}
          trailing={
            <SignedAmount
              minor={tx.walletDelta.amountMinor}
              currency={tx.walletDelta.currency}
              debtMinor={tx.debtDelta.amountMinor}
            />
          }
          {...(reversible(tx)
            ? {
                onPress: () =>
                  navigation.navigate('Reversal', {
                    userId,
                    transactionId: tx.id,
                    title: `${txTitle(tx)} · ${dateTime(tx.createdAt)}`,
                  }),
              }
            : {})}
        />
      )}
      header={<AppText tone="textSecondary">{t('money.reverseBody')}</AppText>}
    />
  );
}

export function ReversalScreen({ route, navigation }: UsersScreenProps<'Reversal'>) {
  const { userId, transactionId, title } = route.params;
  const { t } = useTranslation('manage');
  const errorMessage = useErrorMessage();
  const reverse = useReversal(userId);
  const idempotency = useIdempotencyKey();
  const [reason, setReason] = useState('');
  return (
    <Screen testID="reversal-screen">
      <AppText variant="title2">{t('money.reverseTitle')}</AppText>
      <AppText tone="textSecondary">{title}</AppText>
      <Banner tone="accent" message={t('money.reverseBody')} />
      <TextField
        testID="reversal-reason"
        label={t('money.reason')}
        value={reason}
        onChangeText={setReason}
        multiline
      />
      <FormError message={errorMessage(reverse.error)} />
      <Button
        testID="submit-reversal"
        variant="destructive"
        label={t('money.reverse')}
        disabled={reason.trim().length < 3}
        loading={reverse.isPending}
        onPress={() =>
          reverse.mutate(
            { transactionId, reason: reason.trim(), headers: idempotency.headers },
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
