import type { MeTraining, Notification, Transaction } from '@tw/contracts';
import { type NotificationTranslate, renderNotification } from '@tw/i18n';
import { isCurrencyCode, money } from '@tw/money';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormatDate } from '../../shared/format/date';
import { useFormatMoney } from '../../shared/format/money';

/** Title and body for an in-app notification, in the language the app shows now. */
export function useNotificationText() {
  const { t } = useTranslation('notifications');
  const formatMoney = useFormatMoney();
  const { dateTime, time } = useFormatDate();
  return useCallback(
    (n: Notification): { title: string; body: string } =>
      renderNotification(t as unknown as NotificationTranslate, n, {
        money: (minor, currency) =>
          formatMoney(money(minor, isCurrencyCode(currency) ? currency : 'EUR')),
        dateTime,
        time,
      }),
    [t, formatMoney, dateTime, time],
  );
}

/** "Training: Tuesday club" style title for a ledger row. */
export function useTransactionTitle() {
  const { t } = useTranslation('member');
  return useCallback(
    (tx: Pick<Transaction, 'type' | 'description'>) =>
      tx.type === 'TRAINING_PAYMENT'
        ? `${t('wallet.type.TRAINING_PAYMENT')}: ${tx.description}`
        : t(`wallet.type.${tx.type}`),
    [t],
  );
}

/** The member's state for a training, for the status chip. */
export function trainingState(training: MeTraining): {
  key: 'CANCELLED' | 'ATTENDING' | 'NOT_ATTENDING' | 'none';
  tone: 'danger' | 'success' | 'textSecondary' | 'accent';
} {
  if (training.status === 'CANCELLED') return { key: 'CANCELLED', tone: 'danger' };
  if (training.myReservation === 'ATTENDING') return { key: 'ATTENDING', tone: 'success' };
  if (training.myReservation === 'NOT_ATTENDING')
    return { key: 'NOT_ATTENDING', tone: 'textSecondary' };
  return { key: 'none', tone: 'accent' };
}
