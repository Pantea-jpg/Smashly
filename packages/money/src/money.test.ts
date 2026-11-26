import { describe, expect, it } from 'vitest';
import {
  add,
  compare,
  formatMoney,
  isCurrencyCode,
  isNegative,
  isPositive,
  isZero,
  maxOf,
  minOf,
  money,
  MoneyError,
  negate,
  parseMajorString,
  subtract,
  sum,
  toMajorString,
} from './index';

describe('money()', () => {
  it('accepts integer minor units', () => {
    expect(money(1250)).toEqual({ amountMinor: 1250, currency: 'EUR' });
  });

  it.each([12.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('rejects %s', (value) => {
    expect(() => money(value)).toThrow(MoneyError);
  });

  it('returns frozen values', () => {
    expect(Object.isFrozen(money(1))).toBe(true);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(add(money(10), money(20)).amountMinor).toBe(30);
    expect(subtract(money(1000), money(600)).amountMinor).toBe(400);
  });

  it('never produces -0', () => {
    expect(Object.is(negate(money(0)).amountMinor, 0)).toBe(true);
  });

  it('compares and picks minimum', () => {
    expect(compare(money(5), money(7))).toBe(-1);
    expect(compare(money(7), money(7))).toBe(0);
    expect(minOf(money(600), money(1000)).amountMinor).toBe(600);
  });

  it('sums a list', () => {
    expect(sum([money(1), money(2), money(3)]).amountMinor).toBe(6);
    expect(sum([]).amountMinor).toBe(0);
  });

  it('avoids float drift (0.1 + 0.2 case)', () => {
    expect(add(money(10), money(20)).amountMinor).toBe(30);
  });
});

describe('parseMajorString', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12,50', 1250],
    ['0,01', 1],
    ['007', 700],
    [' 50 ', 5000],
  ])('parses %s → %i', (input, expected) => {
    expect(parseMajorString(input).amountMinor).toBe(expected);
  });

  it.each(['', 'abc', '12.345', '-5', '1.234,56', '1e3', '12.'])('rejects %s', (input) => {
    expect(() => parseMajorString(input)).toThrow(MoneyError);
  });
});

describe('toMajorString', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [1250, '12.50'],
    [-400, '-4.00'],
  ])('%i → %s', (minor, expected) => {
    expect(toMajorString(money(minor))).toBe(expected);
  });
});

describe('formatMoney', () => {
  it('formats Dutch and English locales', () => {
    // Normalise non-breaking spaces emitted by Intl.
    const nl = formatMoney(money(1250), 'nl-NL').replace(/\s/g, ' ');
    const en = formatMoney(money(1250), 'en-GB');
    expect(nl).toBe('€ 12,50');
    expect(en).toBe('€12.50');
  });
});

describe('isCurrencyCode', () => {
  it('only accepts supported currencies', () => {
    expect(isCurrencyCode('EUR')).toBe(true);
    expect(isCurrencyCode('USD')).toBe(false);
    expect(isCurrencyCode('toString')).toBe(false);
  });
});

describe('comparisons and signs (Phase 9 coverage)', () => {
  it('picks the larger of two amounts, keeping the first on a tie', () => {
    const a = money(500);
    const b = money(700);
    expect(maxOf(a, b)).toBe(b);
    expect(maxOf(b, a)).toBe(b);
    const same = money(500);
    expect(maxOf(a, same)).toBe(a);
    expect(minOf(a, same)).toBe(a);
  });

  it('reports zero, positive and negative amounts', () => {
    expect([isZero(money(0)), isPositive(money(0)), isNegative(money(0))]).toEqual([
      true,
      false,
      false,
    ]);
    expect([isZero(money(1)), isPositive(money(1)), isNegative(money(1))]).toEqual([
      false,
      true,
      false,
    ]);
    expect([isZero(money(-1)), isPositive(money(-1)), isNegative(money(-1))]).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('refuses to mix currencies in arithmetic and comparisons', () => {
    // Only EUR is supported today; a second currency must never be silently added to EUR.
    const foreign = { amountMinor: 100, currency: 'USD' } as unknown as ReturnType<typeof money>;
    expect(() => add(money(100), foreign)).toThrow(MoneyError);
    expect(() => subtract(money(100), foreign)).toThrow(/Currency mismatch: EUR vs USD/);
    expect(() => compare(money(100), foreign)).toThrow(MoneyError);
    expect(() => maxOf(money(100), foreign)).toThrow(MoneyError);
  });
});
