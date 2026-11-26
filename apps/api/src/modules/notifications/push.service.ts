import type { NotificationType, QuietHours } from '@tw/contracts';
import {
  DEFAULT_LANGUAGE,
  INTL_LOCALE,
  isSupportedLanguage,
  type Language,
  renderNotification,
  resources,
} from '@tw/i18n';
import { formatMoney, isCurrencyCode, money } from '@tw/money';
import i18next from 'i18next';
import type { PrismaClient } from '../../core/db/prisma';
import type { Logger } from '../../core/logger/logger';
import { enqueueOutbox, type PushJob } from '../../core/outbox/outbox';
import type { PushProvider } from '../../integrations/push/push-provider';
import type { SettingsService } from '../admin/settings.service';
import { addDays, localDate, zonedTimeToUtc } from '../trainings/domain/schedule';

/** D22: payment confirmations are delivered even during quiet hours. */
export const QUIET_HOURS_EXEMPT: ReadonlySet<NotificationType> = new Set([
  'TOP_UP_SUCCEEDED',
  'TOP_UP_FAILED',
  'CASH_PAYMENT_RECORDED',
]);

/** APNs keeps an undeliverable push (phone off) at most this long. */
const DEFAULT_PUSH_TTL_MS = 24 * 60 * 60_000;

/** Params forwarded to the app with the push, so a tap opens the right screen. */
const ROUTE_PARAMS = ['trainingId', 'transactionId', 'paymentId'] as const;

const i18n = i18next.createInstance();
void i18n.init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  ns: ['notifications'],
  defaultNS: 'notifications',
  initAsync: false,
  interpolation: { escapeValue: false }, // plain text, not HTML
});

/** Minutes since local midnight of `instant` in `timeZone`. */
export function localMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/**
 * When quiet hours are in effect at `instant` for someone in `timeZone`, the instant they end;
 * otherwise null. Windows may cross midnight (22:00–08:00).
 */
export function quietHoursEnd(instant: Date, timeZone: string, quiet: QuietHours): Date | null {
  const now = localMinutes(instant, timeZone);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  const inside = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inside) return null;
  const today = localDate(instant, timeZone);
  // Past midnight-crossing start (e.g. 23:00 with 22:00–08:00): the window ends tomorrow.
  const endDate = start > end && now >= start ? addDays(today, 1) : today;
  return zonedTimeToUtc(endDate, quiet.end, timeZone);
}

function formattersFor(language: Language, timeZone: string) {
  const locale = INTL_LOCALE[language];
  const dateTime = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit' });
  return {
    money: (minor: number, currency: string) =>
      formatMoney(money(minor, isCurrencyCode(currency) ? currency : 'EUR'), locale),
    dateTime: (iso: string) => dateTime.format(new Date(iso)),
    time: (iso: string) => time.format(new Date(iso)),
  };
}

/** Push title and body in the recipient's language, with dates in their timezone. */
export function renderPush(
  notification: { type: string; params: Record<string, unknown> },
  language: string,
  timeZone: string,
): { title: string; body: string } {
  const lang = isSupportedLanguage(language) ? language : DEFAULT_LANGUAGE;
  const t = i18n.getFixedT(lang, 'notifications');
  return renderNotification(
    (key, values) => t(key, values ?? {}),
    notification,
    formattersFor(lang, timeZone),
  );
}

export interface PushRunResult {
  sent: number;
  skipped: number;
  deferred: number;
  failed: number;
  pruned: number;
}

/**
 * Delivers the pushes for a batch of notifications (outbox `notification.push`), per device:
 *   - nothing for inactive/deleted users, deleted notifications or users without devices;
 *   - SKIPPED when the user turned the category off (D23) or the push went stale;
 *   - deferred to the end of quiet hours, in the user's own timezone (D22);
 *   - otherwise rendered in the user's language and sent; dead tokens are revoked (pruned).
 * Safe to retry: devices that already have a SENT or SKIPPED row are not pushed again.
 * Throws when a transient failure remains, so the outbox retries with backoff.
 */
export class PushService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: PushProvider,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(job: PushJob): Promise<PushRunResult> {
    const result: PushRunResult = { sent: 0, skipped: 0, deferred: 0, failed: 0, pruned: 0 };
    const now = this.now();
    const quiet = await this.settings.get('notifications.quietHours');
    const notifications = await this.prisma.notification.findMany({
      where: { id: { in: job.notificationIds } },
      include: {
        deliveries: { select: { deviceTokenId: true, status: true } },
        user: {
          select: {
            role: true,
            status: true,
            deletedAt: true,
            profile: { select: { preferredLanguage: true, timezone: true } },
            notificationPrefs: { select: { category: true, pushEnabled: true } },
            deviceTokens: {
              where: { revokedAt: null, provider: 'APNS' },
              select: { id: true, token: true },
            },
          },
        },
      },
    });

    const deferrals = new Map<number, string[]>();
    let transientFailure = false;

    for (const n of notifications) {
      const { user } = n;
      if (n.deletedAt || user.deletedAt || user.status !== 'ACTIVE') continue;
      const done = new Set(
        n.deliveries.filter((d) => d.status !== 'FAILED').map((d) => d.deviceTokenId),
      );
      const devices = user.deviceTokens.filter((d) => !done.has(d.id));
      if (devices.length === 0) continue;

      const skip = async (error: string) => {
        await this.prisma.notificationDelivery.createMany({
          data: devices.map((d) => ({
            notificationId: n.id,
            deviceTokenId: d.id,
            status: 'SKIPPED' as const,
            error,
          })),
        });
        result.skipped += devices.length;
      };

      const pref = user.notificationPrefs.find((p) => p.category === n.category);
      if (pref && !pref.pushEnabled) {
        await skip('disabled_by_preference');
        continue;
      }
      if (job.deferred && n.readAt) {
        await skip('read_during_quiet_hours');
        continue;
      }
      const params = n.params as Record<string, unknown>;
      const startsAt = typeof params['startsAt'] === 'string' ? new Date(params['startsAt']) : null;
      if (n.type === 'TRAINING_REMINDER' && startsAt && startsAt <= now) {
        await skip('expired');
        continue;
      }

      const timeZone = user.profile?.timezone ?? 'Europe/Amsterdam';
      if (quiet && !QUIET_HOURS_EXEMPT.has(n.type)) {
        const until = quietHoursEnd(now, timeZone, quiet);
        if (until) {
          const ids = deferrals.get(until.getTime()) ?? [];
          ids.push(n.id);
          deferrals.set(until.getTime(), ids);
          result.deferred += 1;
          continue;
        }
      }

      const { title, body } = renderPush(
        { type: n.type, params },
        user.profile?.preferredLanguage ?? DEFAULT_LANGUAGE,
        timeZone,
      );
      // Members see an unread badge; admins have no inbox screen to clear one.
      const badge =
        user.role === 'USER'
          ? await this.prisma.notification.count({
              where: { userId: n.userId, readAt: null, deletedAt: null },
            })
          : undefined;
      const data: Record<string, string> = { notificationId: n.id, type: n.type };
      for (const key of ROUTE_PARAMS) {
        if (typeof params[key] === 'string') data[key] = params[key];
      }
      const expiresAt =
        n.type === 'TRAINING_REMINDER' && startsAt
          ? startsAt
          : new Date(now.getTime() + DEFAULT_PUSH_TTL_MS);

      for (const device of devices) {
        const outcome = await this.provider.send({
          token: device.token,
          title,
          body,
          ...(badge !== undefined ? { badge } : {}),
          threadId: n.category,
          data,
          expiresAt,
        });
        await this.prisma.notificationDelivery.create({
          data: {
            notificationId: n.id,
            deviceTokenId: device.id,
            status: outcome.ok ? 'SENT' : 'FAILED',
            providerMessageId: outcome.ok ? outcome.providerMessageId : null,
            error: outcome.ok ? null : outcome.reason.slice(0, 500),
          },
        });
        if (outcome.ok) {
          result.sent += 1;
        } else if (outcome.unregistered) {
          // The token is dead (uninstalled, rotated): never use it again.
          await this.prisma.deviceToken.update({
            where: { id: device.id },
            data: { revokedAt: now },
          });
          result.pruned += 1;
        } else {
          result.failed += 1;
          transientFailure = true;
        }
      }
    }

    for (const [at, ids] of deferrals) {
      await enqueueOutbox(
        this.prisma,
        'notification.push',
        { notificationIds: ids, deferred: true },
        { availableAt: new Date(at) },
      );
    }

    if (transientFailure) {
      this.logger.warn({ result }, 'push delivery partly failed; will retry');
      throw new Error(`push delivery failed for ${String(result.failed)} device(s)`);
    }
    return result;
  }
}
