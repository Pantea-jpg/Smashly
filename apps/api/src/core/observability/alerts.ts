import * as Sentry from '@sentry/node';
import type { Env } from '../../config/env';
import type { Logger } from '../logger/logger';
import { REDACT_PATHS } from '../logger/logger';

/**
 * Alert names. Each becomes a Sentry issue (fingerprinted by name) with level `fatal`, so one
 * Sentry alert rule ("level is fatal → email/Slack") covers all of them. See docs/10-runbooks.md.
 */
export type AlertName =
  | 'reconciliation_mismatch' // cached wallet totals differ from the ledger
  | 'payment_requires_review' // Stripe charged a different amount/currency than agreed
  | 'stripe_webhook_failed' // a verified Stripe event could not be processed (Stripe retries)
  | 'outbox_event_failed' // a background job gave up after all retries
  | 'outbox_backlog'; // background jobs are not being processed

let enabled = false;

/** Turns on Sentry for this process when SENTRY_DSN is set; otherwise alerts only log. */
export function initObservability(
  env: Pick<Env, 'SENTRY_DSN' | 'NODE_ENV' | 'APP_VERSION'>,
  service: 'api' | 'worker',
  /** Tests only: a fake transport instead of the network. */
  testOptions: Pick<Sentry.NodeOptions, 'transport' | 'defaultIntegrations'> = {},
): boolean {
  if (!env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.APP_VERSION,
    serverName: service,
    initialScope: { tags: { service } },
    // Errors only (no performance tracing): keeps the event volume and cost low.
    tracesSampleRate: 0,
    ...testOptions,
    // Never collect users, cookies, headers, query strings or bodies (GDPR); the logs carry the
    // request id to correlate instead. beforeSend below is a second line of defence.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.headers) {
          for (const header of ['authorization', 'cookie', 'x-view-session', 'stripe-signature']) {
            delete event.request.headers[header];
          }
        }
      }
      delete event.user;
      return event;
    },
  });
  enabled = true;
  return true;
}

const REDACTED_KEYS = new Set(
  REDACT_PATHS.map((p) =>
    p
      .split('.')
      .at(-1)!
      .replace(/[[\]"]/g, ''),
  ).filter(Boolean),
);

/** Drops anything that looks like personal data or a secret before it leaves the process. */
function scrub(extra: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(extra).map(([k, v]) => [k, REDACTED_KEYS.has(k) ? '[REDACTED]' : v]),
  );
}

/**
 * The one place that reports problems. An object (not loose functions) so tests can spy on it.
 * Every call also logs, so alerts are visible in the log stream even without Sentry.
 */
export const alerts = {
  /** Something an operator must look at now. */
  critical(logger: Logger, name: AlertName, message: string, extra: Record<string, unknown> = {}) {
    logger.error({ alert: name, ...extra }, `ALERT ${name}: ${message}`);
    if (!enabled) return;
    Sentry.withScope((scope) => {
      scope.setLevel('fatal');
      scope.setTag('alert', name);
      scope.setFingerprint(['alert', name]);
      scope.setContext('details', scrub(extra));
      Sentry.captureMessage(`${name}: ${message}`);
    });
  },

  /** An unexpected exception (500, crashed job). */
  exception(logger: Logger, error: unknown, extra: Record<string, unknown> = {}) {
    logger.error({ err: error, ...extra }, 'unexpected error');
    if (!enabled) return;
    Sentry.withScope((scope) => {
      scope.setContext('details', scrub(extra));
      Sentry.captureException(error);
    });
  },

  /** Sends what is queued (on shutdown). */
  async flush(timeoutMs = 2000): Promise<void> {
    if (enabled) await Sentry.flush(timeoutMs);
  },
};

/** Test helper. */
export function isObservabilityEnabled(): boolean {
  return enabled;
}
