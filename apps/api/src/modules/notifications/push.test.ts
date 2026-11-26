import { describe, expect, it } from 'vitest';
import { localMinutes, quietHoursEnd, renderPush } from './push.service';

const QUIET = { start: '22:00', end: '08:00' };
const AMS = 'Europe/Amsterdam';

describe('quietHoursEnd', () => {
  it.each([
    // [UTC instant, expected end (UTC) or null] — Amsterdam is UTC+1 in winter
    ['2026-11-25T20:59:00Z', null], // 21:59 local
    ['2026-11-25T21:00:00Z', '2026-11-26T07:00:00.000Z'], // 22:00 local → 08:00 tomorrow
    ['2026-11-25T23:30:00Z', '2026-11-26T07:00:00.000Z'], // 00:30 local → 08:00 today
    ['2026-11-26T06:59:00Z', '2026-11-26T07:00:00.000Z'], // 07:59 local
    ['2026-11-26T07:00:00Z', null], // 08:00 local
  ] as const)('%s → %s', (instant, expected) => {
    expect(quietHoursEnd(new Date(instant), AMS, QUIET)?.toISOString() ?? null).toBe(expected);
  });

  it('uses the summer offset across DST (UTC+2)', () => {
    // 23:30 local on 28 Mar 2026 → quiet until 08:00 local on 29 Mar, after clocks go forward.
    expect(quietHoursEnd(new Date('2026-03-28T22:30:00Z'), AMS, QUIET)?.toISOString()).toBe(
      '2026-03-29T06:00:00.000Z',
    );
  });

  it("follows the member's own timezone", () => {
    // 22:30 in Amsterdam is 16:30 in New York: not quiet there.
    expect(quietHoursEnd(new Date('2026-11-25T21:30:00Z'), 'America/New_York', QUIET)).toBeNull();
  });

  it('handles a window that does not cross midnight', () => {
    const lunch = { start: '12:00', end: '13:00' };
    expect(quietHoursEnd(new Date('2026-11-25T11:30:00Z'), AMS, lunch)?.toISOString()).toBe(
      '2026-11-25T12:00:00.000Z',
    );
    expect(quietHoursEnd(new Date('2026-11-25T12:30:00Z'), AMS, lunch)).toBeNull();
  });

  it('localMinutes reads the wall clock', () => {
    expect(localMinutes(new Date('2026-11-25T18:45:00Z'), AMS)).toBe(19 * 60 + 45);
  });
});

describe('renderPush', () => {
  const charged = {
    type: 'TRAINING_CHARGED',
    params: { title: 'Tuesday club', amountMinor: 1250, shortfallMinor: 250, currency: 'EUR' },
  };

  it('renders in Dutch with Dutch money formatting', () => {
    const { title, body } = renderPush(charged, 'nl', AMS);
    expect(title).toBe('Training afgeschreven');
    // Intl uses a non-breaking space after € in nl-NL; normalise for the comparison.
    expect(body.replace(/\s/g, ' ')).toBe('€ 12,50 voor Tuesday club. € 2,50 staat open.');
  });

  it('renders in English', () => {
    expect(renderPush(charged, 'en', AMS)).toEqual({
      title: 'Training charged',
      body: '€12.50 for Tuesday club. €2.50 is outstanding.',
    });
  });

  it("formats times in the member's timezone", () => {
    const reminder = {
      type: 'TRAINING_REMINDER',
      params: { title: 'Tuesday club', startsAt: '2026-11-25T18:00:00Z', window: '2h' },
    };
    expect(renderPush(reminder, 'nl', AMS).body).toBe('Tuesday club begint om 19:00.');
    expect(renderPush(reminder, 'en', 'Europe/London').body).toBe('Tuesday club starts at 18:00.');
  });

  it('falls back to English for an unsupported language', () => {
    expect(renderPush(charged, 'fr', AMS).title).toBe('Training charged');
  });
});
