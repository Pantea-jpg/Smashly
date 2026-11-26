import * as Sentry from '@sentry/node';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { alerts, initObservability, isObservabilityEnabled } from './alerts';

/** Every event Sentry would send, captured by a fake transport instead of the network. */
const sent: Record<string, unknown>[] = [];
const logger = pino({ level: 'silent' });

describe('observability', () => {
  it('stays off (alerts only log) without a DSN', () => {
    expect(
      initObservability({ SENTRY_DSN: undefined, NODE_ENV: 'test', APP_VERSION: 'x' }, 'api'),
    ).toBe(false);
    const error = vi.spyOn(logger, 'error');
    alerts.critical(logger, 'outbox_backlog', 'jobs are stuck', { overdue: 3 });
    expect(error).toHaveBeenCalledWith(
      { alert: 'outbox_backlog', overdue: 3 },
      'ALERT outbox_backlog: jobs are stuck',
    );
    expect(isObservabilityEnabled()).toBe(false);
  });

  describe('with a DSN', () => {
    beforeAll(() => {
      expect(
        initObservability(
          {
            SENTRY_DSN: 'https://public@o1.ingest.de.sentry.io/1',
            NODE_ENV: 'production',
            APP_VERSION: 'abc123',
          },
          'worker',
          {
            defaultIntegrations: false,
            transport: () => ({
              send: (envelope) => {
                for (const [header, payload] of envelope[1] as unknown as [
                  { type: string },
                  Record<string, unknown>,
                ][]) {
                  if (header.type === 'event') sent.push(payload);
                }
                return Promise.resolve({});
              },
              flush: () => Promise.resolve(true),
            }),
          },
        ),
      ).toBe(true);
    });
    afterAll(() => Sentry.close());

    it('sends a critical alert as a fatal, fingerprinted issue with scrubbed details', async () => {
      alerts.critical(logger, 'reconciliation_mismatch', 'totals differ', {
        total: 2,
        email: 'anna@example.test',
        token: 'secret-token',
      });
      await alerts.flush();
      const event = sent.at(-1)!;
      expect(event).toMatchObject({
        level: 'fatal',
        message: 'reconciliation_mismatch: totals differ',
        fingerprint: ['alert', 'reconciliation_mismatch'],
        environment: 'production',
        release: 'abc123',
        tags: { alert: 'reconciliation_mismatch', service: 'worker' },
      });
      const details = (event['contexts'] as Record<string, Record<string, unknown>>)['details'];
      expect(details).toEqual({ total: 2, email: '[REDACTED]', token: '[REDACTED]' });
      expect(event['user']).toBeUndefined();
    });

    it('sends exceptions with their stack and no request secrets', async () => {
      Sentry.getCurrentScope().setSDKProcessingMetadata({
        normalizedRequest: {
          url: 'https://api.example/api/v1/me',
          headers: { authorization: 'Bearer abc', 'user-agent': 'iOS' },
          cookies: { session: 'x' },
          data: '{"password":"hunter2"}',
        },
      });
      alerts.exception(logger, new Error('database restarted'), { requestId: 'req-1' });
      await alerts.flush();
      const event = sent.at(-1)!;
      expect(JSON.stringify(event)).toContain('database restarted');
      expect(JSON.stringify(event)).not.toMatch(/Bearer abc|hunter2|"session"/);
    });
  });
});
