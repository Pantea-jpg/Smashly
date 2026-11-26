/**
 * One renderer for notification texts, shared by the app (in-app list, in the language the
 * app shows now) and the server (push texts, in the recipient's preferred language and
 * timezone). Notifications store a type plus language-neutral params; this picks the
 * template variant and fills it in. Formatting of amounts and dates is passed in, because
 * the app and the server format differently (device locale vs. the user's timezone).
 */

/** A `t` bound to the `notifications` namespace. */
export type NotificationTranslate = (key: string, values?: Record<string, unknown>) => string;

export interface NotificationFormatters {
  /** e.g. "€12.50" / "€ 12,50" */
  money: (amountMinor: number, currency: string) => string;
  /** e.g. "Tue 3 Mar, 19:00" */
  dateTime: (iso: string) => string;
  /** e.g. "19:00" */
  time: (iso: string) => string;
}

export interface RenderableNotification {
  type: string;
  params: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The template under `notifications:types.*` for a notification (some types have variants). */
export function notificationTemplateKey(n: RenderableNotification): string {
  const p = n.params;
  switch (n.type) {
    case 'TRAINING_CREATED':
      return p['seriesId'] ? 'TRAINING_CREATED_SERIES' : n.type;
    case 'TRAINING_CANCELLED':
      return p['refunded'] === true ? 'TRAINING_CANCELLED_REFUNDED' : n.type;
    case 'TRAINING_CHARGED':
      return num(p['shortfallMinor']) > 0 ? 'TRAINING_CHARGED_DEBT' : n.type;
    case 'TRAINING_REMINDER':
      return p['window'] === '2h' ? 'TRAINING_REMINDER_SOON' : n.type;
    default:
      return n.type;
  }
}

/** Every template key the renderer can produce; the i18n tests check each exists. */
export const NOTIFICATION_TEMPLATE_VARIANTS = [
  'TRAINING_CREATED_SERIES',
  'TRAINING_CANCELLED_REFUNDED',
  'TRAINING_CHARGED_DEBT',
  'TRAINING_REMINDER_SOON',
] as const;

export function renderNotification(
  t: NotificationTranslate,
  n: RenderableNotification,
  format: NotificationFormatters,
): { title: string; body: string } {
  const p = n.params;
  const currency = str(p['currency']) || 'EUR';
  const price = p['price'] as { amountMinor?: unknown; currency?: unknown } | undefined;
  const amountMinor = p['amountMinor'] ?? price?.amountMinor;
  const startsAt = str(p['startsAt']);
  const values = {
    title: str(p['title']) || str(p['trainingTitle']),
    date: startsAt ? format.dateTime(startsAt) : '',
    time: startsAt ? format.time(startsAt) : '',
    reason: str(p['reason']),
    count: num(p['sessions']),
    amount: format.money(num(amountMinor), str(price?.currency) || currency),
    debt: format.money(num(p['shortfallMinor']), currency),
    status: t(str(p['status']) === 'ATTENDING' ? 'status.ATTENDING' : 'status.NOT_ATTENDING'),
  };
  const key = notificationTemplateKey(n);
  return { title: t(`types.${key}.title`), body: t(`types.${key}.body`, values) };
}
