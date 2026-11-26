import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

/**
 * Crash and error reporting for the app (Sentry, EU region). Configured per EAS build profile:
 *   EXPO_PUBLIC_SENTRY_DSN   – the project's DSN (not a secret; it only allows sending events)
 *   EXPO_PUBLIC_APP_ENV      – development | staging | production
 * Must stay literal `process.env.EXPO_PUBLIC_…` reads: Expo inlines them at build time.
 * Without a DSN (development, tests) nothing is sent.
 */
const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV ?? 'development';

/** Request headers that must never leave the phone. */
const SECRET_HEADERS = ['authorization', 'cookie', 'x-view-session', 'idempotency-key'];

type ScrubbableEvent = {
  user?: unknown;
  request?: { headers?: Record<string, string>; data?: unknown; cookies?: unknown };
  breadcrumbs?: { category?: string; data?: Record<string, unknown> }[];
};

/**
 * Strips personal data before an event is sent (GDPR): no user, no request bodies or secret
 * headers, and no request bodies in HTTP breadcrumbs (they can hold amounts, emails, tokens).
 */
export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  delete event.user;
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    for (const header of SECRET_HEADERS) delete event.request.headers?.[header];
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.data) {
      delete crumb.data['body'];
      delete crumb.data['request_body'];
      delete crumb.data['response_body'];
    }
  }
  return event;
}

export function initSentry(): boolean {
  if (!DSN) return false;
  Sentry.init({
    dsn: DSN,
    environment: APP_ENV,
    release: `training-wallet@${Constants.expoConfig?.version ?? '0.0.0'}`,
    sendDefaultPii: false,
    tracesSampleRate: 0, // errors and crashes only
    beforeSend: (event) => scrubEvent(event),
  });
  return true;
}
