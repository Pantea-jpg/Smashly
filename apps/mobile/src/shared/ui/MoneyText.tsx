import type { MoneyDto } from '@tw/contracts';
import { money } from '@tw/money';
import { useFormatMoney } from '../format/money';
import { AppText, type AppTextProps } from './AppText';

/**
 * Displays an amount from integer minor units, formatted for the active language.
 * Debt is shown in the danger tone and never as a negative balance.
 */
export function MoneyText({
  value,
  kind = 'balance',
  ...textProps
}: { value: MoneyDto; kind?: 'balance' | 'debt' } & Omit<AppTextProps, 'children'>) {
  const format = useFormatMoney();
  const tone = kind === 'debt' && value.amountMinor > 0 ? 'danger' : textProps.tone;
  return (
    <AppText {...textProps} {...(tone ? { tone } : {})}>
      {format(money(value.amountMinor, value.currency))}
    </AppText>
  );
}
