import type { Env } from '../../config/env';
import type { Logger } from '../../core/logger/logger';
import { ApnsPushProvider } from './apns';
import { LogPushProvider, type PushProvider } from './push-provider';

/** APNs when configured; otherwise pushes are only logged (development). */
export function createPushProvider(env: Env, logger: Logger): PushProvider {
  if (env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY) {
    return new ApnsPushProvider({
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      privateKeyPem: Buffer.from(env.APNS_PRIVATE_KEY, 'base64').toString('utf8'),
      bundleId: env.APNS_BUNDLE_ID,
      environment: env.APNS_ENVIRONMENT,
    });
  }
  logger.warn('APNs not configured: push notifications are logged, not sent');
  return new LogPushProvider((message) =>
    logger.info(
      { title: message.title, body: message.body, badge: message.badge, data: message.data },
      'push (not sent: APNs not configured)',
    ),
  );
}
