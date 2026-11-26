import { useCallback } from 'react';
import { useIntlLocale } from '../i18n/I18nProvider';

/** Locale-aware date/time formatters for the active language (24h clock in en-GB and nl-NL). */
export function useFormatDate() {
  const locale = useIntlLocale();
  const dateTime = useCallback(
    (iso: string) =>
      new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso)),
    [locale],
  );
  const date = useCallback(
    (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso)),
    [locale],
  );
  const time = useCallback(
    (iso: string) =>
      new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)),
    [locale],
  );
  /** "Tue 3 Mar, 19:00 – 20:30" */
  const range = useCallback(
    (startIso: string, endIso: string) => `${dateTime(startIso)} – ${time(endIso)}`,
    [dateTime, time],
  );
  return { dateTime, date, time, range };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local "YYYY-MM-DD" and "HH:MM" of an instant (for editing in form fields). */
export function toLocalParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Local date + time typed by the user → ISO instant, or null when invalid. */
export function fromLocalParts(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const local = new Date(y, m - 1, d, hh, mm);
  if (local.getFullYear() !== y || local.getMonth() !== m - 1 || local.getDate() !== d) return null;
  return local.toISOString();
}
