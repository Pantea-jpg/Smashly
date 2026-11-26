import { pino, type Logger } from 'pino';
import type { Env } from '../../config/env';

/**
 * Paths that must never reach log storage. Applies to structured fields
 * (pino-http request/response objects and anything passed by services).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-view-session"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.clientSecret',
  '*.email',
  '*.phone',
];

export function createLogger(
  env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV' | 'APP_VERSION'>,
  service: 'api' | 'worker' | 'seed' = 'api',
): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service, version: env.APP_VERSION, env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export type { Logger };
