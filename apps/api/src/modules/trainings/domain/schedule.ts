/**
 * Recurring schedules (D7) and wall-clock ↔ UTC conversion. Pure functions, no I/O.
 *
 * A series stores an RFC 5545 RRULE. We support the subset the product needs:
 * FREQ=WEEKLY with BYDAY (one or more weekdays) and an optional INTERVAL (every n weeks).
 * Occurrences are local dates; each becomes a UTC instant at the series' local start time in
 * its IANA timezone, so "every Tuesday 19:00" stays 19:00 in Amsterdam across DST changes.
 */

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface WeeklyRule {
  weekdays: Weekday[];
  intervalWeeks: number;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function toRRule(rule: WeeklyRule): string {
  const days = WEEKDAYS.filter((d) => rule.weekdays.includes(d));
  return `FREQ=WEEKLY;INTERVAL=${rule.intervalWeeks};BYDAY=${days.join(',')}`;
}

export function parseRRule(rrule: string): WeeklyRule {
  const parts = new Map(
    rrule.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k?.toUpperCase() ?? '', v ?? ''] as const;
    }),
  );
  if (parts.get('FREQ') !== 'WEEKLY') throw new Error(`Unsupported RRULE: ${rrule}`);
  const weekdays = (parts.get('BYDAY') ?? '').split(',').filter(Boolean) as Weekday[];
  if (weekdays.length === 0 || weekdays.some((d) => !WEEKDAYS.includes(d))) {
    throw new Error(`Unsupported RRULE BYDAY: ${rrule}`);
  }
  const intervalWeeks = Number(parts.get('INTERVAL') ?? '1');
  if (!Number.isInteger(intervalWeeks) || intervalWeeks < 1)
    throw new Error(`Bad INTERVAL: ${rrule}`);
  return { weekdays, intervalWeeks };
}

/** "2026-03-31" → days since 1970-01-01 (calendar arithmetic, no timezone involved). */
function dayNumber(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

function fromDayNumber(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Monday = 0 … Sunday = 6. */
function weekdayIndex(day: number): number {
  return (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
}

/**
 * Local dates of a weekly rule from `startsOn` to `until` (both inclusive). INTERVAL counts
 * calendar weeks (Monday-based) from the week containing `startsOn`.
 */
export function weeklyOccurrences(rule: WeeklyRule, startsOn: string, until: string): string[] {
  const first = dayNumber(startsOn);
  const last = dayNumber(until);
  const firstMonday = first - weekdayIndex(first);
  const wanted = new Set(rule.weekdays.map((d) => WEEKDAYS.indexOf(d)));
  const dates: string[] = [];
  for (let day = first; day <= last; day += 1) {
    const week = Math.floor((day - firstMonday) / 7);
    if (week % rule.intervalWeeks === 0 && wanted.has(weekdayIndex(day)))
      dates.push(fromDayNumber(day));
  }
  return dates;
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (e.g. +120 for Amsterdam in summer). */
export function timeZoneOffsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const instantMinute = Math.floor(instant.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - instantMinute) / 60_000);
}

/**
 * The UTC instant of a local wall-clock time in `timeZone`. A time that does not exist (inside
 * a spring-forward gap) resolves to the instant one offset later, i.e. it moves forward.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const t = TIME_RE.exec(time);
  if (!t) throw new Error(`Invalid time: ${time}`);
  const guess = dayNumber(date) * DAY_MS + (Number(t[1]) * 60 + Number(t[2])) * 60_000;
  const firstOffset = timeZoneOffsetMinutes(timeZone, new Date(guess));
  let result = guess - firstOffset * 60_000;
  const secondOffset = timeZoneOffsetMinutes(timeZone, new Date(result));
  if (secondOffset !== firstOffset) result = guess - secondOffset * 60_000;
  return new Date(result);
}

/** Today's local date in `timeZone`, as "YYYY-MM-DD". */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
