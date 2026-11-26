import {
  initPaymentSheet,
  initStripe,
  PaymentSheetError,
  presentPaymentSheet,
} from '@stripe/stripe-react-native';
import { money } from '@tw/money';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useIdempotencyKey } from '../../../shared/api/idempotency';
import { APP_SCHEME, STRIPE_RETURN_URL } from '../../../shared/config/appScheme';
import { hapticSuccess, hapticWarning } from '../../../shared/feedback/feedback';
import { parseAmountToMinor } from '../../../shared/format/amount';
import { useFormatMoney } from '../../../shared/format/money';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { FormError } from '../../../shared/ui/FormScreen';
import { Screen } from '../../../shared/ui/Screen';
import { Banner, ErrorState, Skeleton } from '../../../shared/ui/States';
import { TextField } from '../../../shared/ui/TextField';
import { useCreateTopUp, useInvalidateMoney, usePaymentStatus, useWallet } from '../api';
import type { WalletScreenProps } from '../navigation';

/** Deep link Stripe returns to after iDEAL / 3-D Secure in the bank app or browser. */
const MERCHANT_ID = 'merchant.com.trainingwallet.app';

type Phase =
  | { kind: 'choose' }
  | { kind: 'confirming'; paymentId: string }
  | { kind: 'canceled' }
  | { kind: 'failed' };

/**
 * Top-up with Stripe PaymentSheet (card, Apple Pay, iDEAL). The app never credits the wallet:
 * the server does so only after Stripe's signed webhook, so this screen waits for the payment
 * to reach SUCCEEDED before saying "added to your wallet".
 */
export function TopUpScreen({ navigation }: WalletScreenProps<'TopUp'>) {
  const { t } = useTranslation('member');
  const theme = useTheme();
  const formatMoney = useFormatMoney();
  const errorMessage = useErrorMessage();
  const wallet = useWallet();
  const createTopUp = useCreateTopUp();
  const idempotency = useIdempotencyKey();
  const invalidateMoney = useInvalidateMoney();
  const [selected, setSelected] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [sheetBusy, setSheetBusy] = useState(false);
  const payment = usePaymentStatus(phase.kind === 'confirming' ? phase.paymentId : null);

  const status = payment.data?.status;
  const succeeded = status === 'SUCCEEDED';
  // A payment the bank declined after the sheet closed (e.g. iDEAL) ends as FAILED/CANCELED.
  const failedLater = status === 'FAILED' || status === 'CANCELED';
  useEffect(() => {
    if (succeeded) {
      hapticSuccess();
      void invalidateMoney();
    }
    if (failedLater) hapticWarning();
  }, [succeeded, failedLater, invalidateMoney]);

  if (wallet.isPending) {
    return (
      <Screen>
        <Skeleton rows={2} />
      </Screen>
    );
  }
  if (!wallet.data) {
    return (
      <Screen>
        <ErrorState error={wallet.error} onRetry={() => void wallet.refetch()} />
      </Screen>
    );
  }

  const limits = wallet.data.topUpLimits;
  const currency = wallet.data.balance.currency;
  const fmt = (minor: number) => formatMoney(money(minor, currency));
  const customMinor = custom.trim() ? parseAmountToMinor(custom) : null;
  const amountMinor = custom.trim() ? customMinor : selected;
  const valid =
    amountMinor !== null && amountMinor >= limits.minMinor && amountMinor <= limits.maxMinor;

  const pay = async () => {
    if (!valid || amountMinor === null) return;
    setSheetBusy(true);
    try {
      const intent = await createTopUp.mutateAsync({
        amountMinor,
        currency,
        idempotencyKey: idempotency.headers,
      });
      await initStripe({
        publishableKey: intent.publishableKey,
        merchantIdentifier: MERCHANT_ID,
        urlScheme: APP_SCHEME,
      });
      const init = await initPaymentSheet({
        paymentIntentClientSecret: intent.clientSecret,
        merchantDisplayName: t('topUp.merchantName'),
        returnURL: STRIPE_RETURN_URL,
        applePay: { merchantCountryCode: 'NL' },
      });
      if (init.error) {
        setPhase({ kind: 'failed' });
        return;
      }
      const result = await presentPaymentSheet();
      if (result.error) {
        setPhase(
          result.error.code === PaymentSheetError.Canceled
            ? { kind: 'canceled' }
            : { kind: 'failed' },
        );
        return;
      }
      // A new top-up after this one must be a new payment.
      idempotency.renew();
      setPhase({ kind: 'confirming', paymentId: intent.paymentId });
    } catch {
      // createTopUp errors are shown from its state below.
    } finally {
      setSheetBusy(false);
    }
  };

  if (phase.kind === 'confirming') {
    return (
      <Screen testID="top-up-confirming">
        {succeeded && payment.data ? (
          <>
            <Banner
              testID="top-up-success"
              tone="success"
              message={t('topUp.success', { amount: fmt(payment.data.amount.amountMinor) })}
            />
            <Button
              testID="top-up-done"
              label={t('topUp.done')}
              onPress={() => navigation.navigate('WalletHome')}
            />
          </>
        ) : failedLater ? (
          <>
            <Banner testID="top-up-failed" tone="danger" message={t('topUp.failed')} />
            <Button
              testID="top-up-done"
              variant="secondary"
              label={t('topUp.done')}
              onPress={() => navigation.navigate('WalletHome')}
            />
          </>
        ) : (
          <View
            style={{ alignItems: 'center', gap: theme.spacing.md, paddingTop: theme.spacing.xxl }}
          >
            <ActivityIndicator />
            <AppText tone="textSecondary">{t('topUp.processing')}</AppText>
          </View>
        )}
      </Screen>
    );
  }

  return (
    <Screen testID="top-up-screen">
      {phase.kind === 'canceled' ? (
        <Banner testID="top-up-canceled" tone="accent" message={t('topUp.canceled')} />
      ) : null}
      {phase.kind === 'failed' ? (
        <Banner testID="top-up-failed" tone="danger" message={t('topUp.failed')} />
      ) : null}

      <AppText variant="headline">{t('topUp.choose')}</AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
        {limits.presetsMinor
          .filter((p) => p >= limits.minMinor && p <= limits.maxMinor)
          .map((preset) => {
            const active = !custom.trim() && selected === preset;
            return (
              <Pressable
                key={preset}
                testID={`preset-${preset}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  setSelected(preset);
                  setCustom('');
                }}
                style={{
                  minWidth: 96,
                  minHeight: 48,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: theme.radii.sm,
                  borderWidth: 2,
                  borderColor: active ? theme.colors.accent : theme.colors.separator,
                  backgroundColor: theme.colors.surface,
                }}
              >
                <AppText
                  variant="headline"
                  style={active ? { color: theme.colors.accent } : undefined}
                >
                  {fmt(preset)}
                </AppText>
              </Pressable>
            );
          })}
      </View>
      <TextField
        testID="top-up-custom"
        label={t('topUp.custom')}
        keyboardType="decimal-pad"
        value={custom}
        onChangeText={setCustom}
        hint={t('topUp.limits', { min: fmt(limits.minMinor), max: fmt(limits.maxMinor) })}
        error={
          custom.trim() && !valid
            ? t('topUp.invalid', { min: fmt(limits.minMinor), max: fmt(limits.maxMinor) })
            : undefined
        }
      />
      <AppText variant="footnote" tone="textSecondary">
        {t('topUp.methods')}
      </AppText>
      <FormError message={errorMessage(createTopUp.error)} />
      <Button
        testID="top-up-pay"
        label={
          valid && amountMinor !== null
            ? t('topUp.pay', { amount: fmt(amountMinor) })
            : t('topUp.title')
        }
        disabled={!valid}
        loading={sheetBusy}
        onPress={() => void pay()}
      />
    </Screen>
  );
}
