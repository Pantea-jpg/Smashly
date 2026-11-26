import * as Sentry from '@sentry/react-native';
import { initSentry, scrubEvent } from './sentry';

describe('app crash reporting', () => {
  it('sends nothing without a DSN (development and tests)', () => {
    expect(initSentry()).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('strips the user, request bodies, secret headers and HTTP breadcrumb bodies', () => {
    const event = scrubEvent({
      user: { email: 'anna@example.test' },
      request: {
        headers: {
          authorization: 'Bearer secret',
          'x-view-session': 'vs',
          'idempotency-key': 'k',
          'user-agent': 'iOS',
        },
        data: '{"amountMinor":2500}',
        cookies: { a: 'b' },
      },
      breadcrumbs: [{ category: 'fetch', data: { url: '/me', body: '{"password":"x"}' } }],
    });
    expect(event).toEqual({
      request: { headers: { 'user-agent': 'iOS' } },
      breadcrumbs: [{ category: 'fetch', data: { url: '/me' } }],
    });
  });
});
