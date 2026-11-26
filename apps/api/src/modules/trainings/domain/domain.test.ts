import { describe, expect, it } from 'vitest';
import { resolvePrice } from './pricing';
import {
  addDays,
  localDate,
  parseRRule,
  timeZoneOffsetMinutes,
  toRRule,
  weeklyOccurrences,
  zonedTimeToUtc,
} from './schedule';

const AMS = 'Europe/Amsterdam';

describe('resolvePrice (D5)', () => {
  it('prefers the override, then the standing price, then the default', () => {
    expect(resolvePrice({ defaultPriceMinor: 1000 })).toEqual({
      priceMinor: 1000,
      source: 'TRAINING_DEFAULT',
    });
    expect(resolvePrice({ defaultPriceMinor: 1000, standingPriceMinor: 800 })).toEqual({
      priceMinor: 800,
      source: 'USER_STANDING_PRICE',
    });
    expect(
      resolvePrice({ defaultPriceMinor: 1000, standingPriceMinor: 800, overridePriceMinor: 1200 }),
    ).toEqual({
      priceMinor: 1200,
      source: 'TRAINING_OVERRIDE',
    });
  });

  it('treats an override of 0 as "free for this user", not as missing', () => {
    expect(
      resolvePrice({ defaultPriceMinor: 1000, standingPriceMinor: 800, overridePriceMinor: 0 }),
    ).toEqual({
      priceMinor: 0,
      source: 'TRAINING_OVERRIDE',
    });
  });
});

describe('RRULE subset', () => {
  it('round-trips weekly rules with weekdays in calendar order', () => {
    const rrule = toRRule({ weekdays: ['TH', 'TU'], intervalWeeks: 2 });
    expect(rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH');
    expect(parseRRule(rrule)).toEqual({ weekdays: ['TU', 'TH'], intervalWeeks: 2 });
  });

  it('rejects rules outside the supported subset', () => {
    expect(() => parseRRule('FREQ=DAILY')).toThrow();
    expect(() => parseRRule('FREQ=WEEKLY;BYDAY=XX')).toThrow();
  });
});

describe('weeklyOccurrences', () => {
  it('lists every Tuesday and Thursday in the range', () => {
    // 2026-03-02 is a Monday.
    expect(
      weeklyOccurrences({ weekdays: ['TU', 'TH'], intervalWeeks: 1 }, '2026-03-02', '2026-03-15'),
    ).toEqual(['2026-03-03', '2026-03-05', '2026-03-10', '2026-03-12']);
  });

  it('counts INTERVAL in calendar weeks from the first week, starting mid-week', () => {
    // Starts Wednesday 2026-03-04: the Tuesday of that week is before the start and skipped.
    expect(
      weeklyOccurrences({ weekdays: ['TU', 'FR'], intervalWeeks: 2 }, '2026-03-04', '2026-03-31'),
    ).toEqual(['2026-03-06', '2026-03-17', '2026-03-20', '2026-03-31']);
  });

  it('returns nothing for an empty range', () => {
    expect(
      weeklyOccurrences({ weekdays: ['MO'], intervalWeeks: 1 }, '2026-03-10', '2026-03-09'),
    ).toEqual([]);
  });
});

describe('zonedTimeToUtc (DST)', () => {
  it('keeps 19:00 local across the spring-forward change (29 March 2026)', () => {
    expect(zonedTimeToUtc('2026-03-24', '19:00', AMS).toISOString()).toBe(
      '2026-03-24T18:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-03-31', '19:00', AMS).toISOString()).toBe(
      '2026-03-31T17:00:00.000Z',
    );
  });

  it('keeps 19:00 local across the fall-back change (25 October 2026)', () => {
    expect(zonedTimeToUtc('2026-10-20', '19:00', AMS).toISOString()).toBe(
      '2026-10-20T17:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-10-27', '19:00', AMS).toISOString()).toBe(
      '2026-10-27T18:00:00.000Z',
    );
  });

  it('moves a time inside the spring-forward gap forward', () => {
    // 02:30 does not exist on 29 March 2026 in Amsterdam; it becomes 03:30 CEST = 01:30Z.
    expect(zonedTimeToUtc('2026-03-29', '02:30', AMS).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });

  it('works for other zones and midnight', () => {
    expect(zonedTimeToUtc('2026-07-01', '00:00', 'America/New_York').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
    expect(timeZoneOffsetMinutes(AMS, new Date('2026-01-15T12:00:00Z'))).toBe(60);
  });

  it('computes local dates and day arithmetic', () => {
    expect(localDate(new Date('2026-03-28T23:30:00Z'), AMS)).toBe('2026-03-29');
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
  });
});
