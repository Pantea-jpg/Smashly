import { formatMoney, type Money } from '@tw/money';
import { useCallback } from 'react';
import { useIntlLocale } from '../i18n/I18nProvider';

/** Returns a formatter bound to the active language, e.g. "€ 12,50" (nl) / "€12.50" (en). */
export function useFormatMoney(): (value: Money) => string {
  const locale = useIntlLocale();
  return useCallback((value: Money) => formatMoney(value, locale), [locale]);
}
