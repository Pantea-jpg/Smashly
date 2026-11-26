import { describe, expect, it } from 'vitest';
import {
  CursorQuerySchema,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  MoneySchema,
  sortQuerySchema,
} from './index';

describe('MoneySchema', () => {
  it('accepts integer minor units in a supported currency', () => {
    expect(MoneySchema.parse({ amountMinor: 1250, currency: 'EUR' })).toEqual({
      amountMinor: 1250,
      currency: 'EUR',
    });
  });

  it.each([
    { amountMinor: 12.5, currency: 'EUR' },
    { amountMinor: 100, currency: 'USD' },
    { amountMinor: 2 ** 31, currency: 'EUR' },
  ])('rejects %o', (value) => {
    expect(MoneySchema.safeParse(value).success).toBe(false);
  });
});

describe('sortQuerySchema', () => {
  const schema = sortQuerySchema(['createdAt', 'lastName']);

  it('parses directions', () => {
    expect(schema.parse('-createdAt,lastName')).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'lastName', direction: 'asc' },
    ]);
  });

  it('rejects fields outside the allow-list', () => {
    expect(schema.safeParse('passwordHash').success).toBe(false);
  });

  it('defaults to no sorting', () => {
    expect(schema.parse(undefined)).toEqual([]);
  });
});

describe('CursorQuerySchema', () => {
  it('coerces and bounds limit', () => {
    expect(CursorQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(CursorQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });
});

describe('error codes', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});
