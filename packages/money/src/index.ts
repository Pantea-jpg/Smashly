/**
 * Money primitives shared by the API and the mobile app.
 *
 * Rules:
 *  - Amounts are ALWAYS integers in minor units (e.g. euro cents).
 *  - No floating-point arithmetic is ever performed on money.
 *  - Operations on two amounts require the same currency.
 */

export const CURRENCIES = {
  EUR: { minorUnits: 2 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export const DEFAULT_CURRENCY: CurrencyCode = 'EUR';

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCIES, value);
}

export function assertMinorUnits(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Amount must be a safe integer in minor units, got ${String(value)}`);
  }
}

export function money(amountMinor: number, currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  assertMinorUnits(amountMinor);
  return Object.freeze({ amountMinor, currency });
}

export function zero(currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  // Widened to string: with a single supported currency the comparison narrows to `never`.
  const left: string = a.currency;
  const right: string = b.currency;
  if (left !== right) {
    throw new MoneyError(`Currency mismatch: ${left} vs ${right}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(a.amountMinor === 0 ? 0 : -a.amountMinor, a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor === b.amountMinor ? 0 : a.amountMinor < b.amountMinor ? -1 : 1;
}

export function minOf(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function maxOf(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0;
}

export function isPositive(a: Money): boolean {
  return a.amountMinor > 0;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0;
}

export function sum(items: readonly Money[], currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  return items.reduce<Money>((acc, item) => add(acc, item), zero(currency));
}

/**
 * Parses a user-typed decimal string ("12", "12.5", "12,50", "€ 1.234,56" is NOT accepted —
 * thousands separators are rejected to avoid ambiguity) into minor units, without floats.
 * Accepts either "." or "," as the decimal separator.
 */
export function parseMajorString(input: string, currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  const { minorUnits } = CURRENCIES[currency];
  const trimmed = input.trim();
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(trimmed);
  if (!match) {
    throw new MoneyError(`Invalid amount: "${input}"`);
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > minorUnits) {
    throw new MoneyError(`Too many decimal places for ${currency}: "${input}"`);
  }
  const minorString = whole + fraction.padEnd(minorUnits, '0');
  const amountMinor = Number(minorString.replace(/^0+(?=\d)/, ''));
  return money(amountMinor, currency);
}

/** Converts minor units to a plain decimal string ("1250" → "12.50"). For inputs/exports, not display. */
export function toMajorString(value: Money): string {
  const { minorUnits } = CURRENCIES[value.currency];
  const negative = value.amountMinor < 0;
  const digits = Math.abs(value.amountMinor)
    .toString()
    .padStart(minorUnits + 1, '0');
  const whole = digits.slice(0, digits.length - minorUnits);
  const fraction = digits.slice(digits.length - minorUnits);
  return `${negative ? '-' : ''}${whole}${minorUnits > 0 ? `.${fraction}` : ''}`;
}

/** Locale-aware display, e.g. nl-NL → "€ 12,50", en → "€12.50". */
export function formatMoney(value: Money, locale: string): string {
  const { minorUnits } = CURRENCIES[value.currency];
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
  });
  // Intl accepts a decimal string, so no float conversion of the integer amount is needed.
  return formatter.format(toMajorString(value) as Intl.StringNumericLiteral);
}
