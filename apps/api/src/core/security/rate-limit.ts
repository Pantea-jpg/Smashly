import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RedisClientType } from 'redis';
import { AppError } from '../errors/app-error';

export interface RateLimitRule {
  windowMs: number;
  limit: number;
}

/**
 * Defaults per endpoint group. Tests override individual rules.
 *
 * Login has three layers (Phase 9 tuning, ASVS 2.2.1):
 *   - `login`: 5 attempts a minute per IP + email (typos and quick retries);
 *   - `loginAccount`: 10 FAILED attempts per 15 minutes per email, from any IP. This slows a
 *     distributed guessing attack on one account; it is a soft, self-expiring lock;
 *   - `loginIp`: 30 FAILED attempts per 15 minutes per IP, across all emails (credential
 *     stuffing / password spraying from one host).
 * Successful sign-ins never count towards the two failure limits.
 */
export const DEFAULT_RATE_LIMITS = {
  global: { windowMs: 60_000, limit: 300 },
  login: { windowMs: 60_000, limit: 5 },
  loginAccount: { windowMs: 15 * 60_000, limit: 10 },
  loginIp: { windowMs: 15 * 60_000, limit: 30 },
  register: { windowMs: 60 * 60_000, limit: 10 },
  refresh: { windowMs: 60_000, limit: 30 },
  passwordForgot: { windowMs: 60 * 60_000, limit: 5 },
  passwordReset: { windowMs: 60 * 60_000, limit: 10 },
  emailVerify: { windowMs: 60 * 60_000, limit: 20 },
  emailResend: { windowMs: 60 * 60_000, limit: 3 },
} satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof DEFAULT_RATE_LIMITS;
export type RateLimitConfig = Record<RateLimitName, RateLimitRule>;
export type RateLimiters = Record<RateLimitName, RequestHandler>;

function bodyEmail(body: unknown): string {
  if (body && typeof body === 'object' && 'email' in body) {
    const email = body.email;
    if (typeof email === 'string') return email.trim().toLowerCase().slice(0, 254);
  }
  return '';
}

/** IPv6 addresses are grouped by /56 so one host cannot rotate through addresses. */
function ipKey(ip: string | undefined): string {
  return ipKeyGenerator(ip ?? 'unknown');
}

/**
 * Builds the limiters. With a Redis client the counters are shared by all API instances
 * (required in staging/production); without one they are per-process (development/tests).
 */
export function createRateLimiters(options: {
  redis?: RedisClientType | undefined;
  config?: Partial<RateLimitConfig>;
}): RateLimiters {
  const config: RateLimitConfig = { ...DEFAULT_RATE_LIMITS, ...options.config };

  const storeFor = (name: string): Store | undefined =>
    options.redis
      ? new RedisStore({
          prefix: `rl:${name}:`,
          sendCommand: (...args: string[]) => options.redis!.sendCommand(args),
        })
      : undefined;

  const build = (
    name: RateLimitName,
    keyGenerator: (req: Parameters<RequestHandler>[0]) => string,
    options: { failuresOnly?: boolean } = {},
  ): RequestHandler => {
    const store = storeFor(name);
    return rateLimit({
      windowMs: config[name].windowMs,
      limit: config[name].limit,
      // Count only responses with status >= 400 (a successful sign-in is not an attempt to slow).
      skipSuccessfulRequests: options.failuresOnly ?? false,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator,
      // Every key goes through ipKey() (ipKeyGenerator, IPv6 grouped by /56). The library's
      // check only spots req.ip in the function source and would warn on every request.
      validate: { keyGeneratorIpFallback: false },
      ...(store ? { store } : {}),
      handler: (_req, _res, next) => {
        next(new AppError('RATE_LIMITED', 'Too many requests'));
      },
    });
  };

  const byIp = (req: Parameters<RequestHandler>[0]) => ipKey(req.ip);
  const byIpAndEmail = (req: Parameters<RequestHandler>[0]) =>
    `${ipKey(req.ip)}|${bodyEmail(req.body)}`;
  const byActor = (req: Parameters<RequestHandler>[0]) => req.context.actor?.id ?? ipKey(req.ip);
  const byEmail = (req: Parameters<RequestHandler>[0]) => bodyEmail(req.body) || ipKey(req.ip);

  return {
    global: build('global', byIp),
    login: build('login', byIpAndEmail),
    loginAccount: build('loginAccount', byEmail, { failuresOnly: true }),
    loginIp: build('loginIp', byIp, { failuresOnly: true }),
    register: build('register', byIp),
    refresh: build('refresh', byIp),
    passwordForgot: build('passwordForgot', byIpAndEmail),
    passwordReset: build('passwordReset', byIp),
    emailVerify: build('emailVerify', byIp),
    emailResend: build('emailResend', byActor),
  };
}
