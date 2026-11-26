import { createServer } from 'node:http';
import { createClient, type RedisClientType } from 'redis';
import { createApp } from './app';
import { EnvValidationError, loadEnv } from './config/env';
import { HibpPasswordCheck } from './core/auth/breached-passwords';
import { TokenService } from './core/auth/tokens';
import { createPrismaClient } from './core/db/prisma';
import { createLogger } from './core/logger/logger';
import { alerts, initObservability } from './core/observability/alerts';
import { outboxBacklog } from './core/outbox/outbox';
import { createRateLimiters } from './core/security/rate-limit';
import { StripePaymentProvider } from './integrations/payments/payment-provider';
import { S3ObjectStorage } from './integrations/storage/object-storage';
import type { DependencyCheck } from './modules/health/health.routes';
import { attachRealtime } from './modules/realtime/realtime.server';

const SHUTDOWN_TIMEOUT_MS = 15_000;
const OUTBOX_WATCH_INTERVAL_MS = 5 * 60_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env, 'api');
  if (!initObservability(env, 'api')) logger.warn('SENTRY_DSN not set: alerts are only logged');
  const prisma = createPrismaClient(env.DATABASE_URL);
  const tokens = new TokenService(env);
  const paymentProvider = StripePaymentProvider.fromEnv(env);
  if (!paymentProvider) logger.warn('Stripe not configured: online top-ups are disabled');

  let redis: RedisClientType | undefined;
  if (env.REDIS_URL) {
    redis = createClient({ url: env.REDIS_URL });
    redis.on('error', (err: unknown) => logger.error({ err }, 'redis error'));
    await redis.connect();
  } else {
    logger.warn('REDIS_URL not set: rate limits are per-process (development only)');
  }

  const healthChecks: DependencyCheck[] = [
    {
      name: 'database',
      check: async () => {
        await prisma.$queryRaw`SELECT 1`;
      },
    },
  ];
  if (redis) {
    const client = redis;
    healthChecks.push({
      name: 'redis',
      check: async () => {
        await client.ping();
      },
    });
  }

  const app = createApp({
    env,
    logger,
    prisma,
    tokens,
    storage: new S3ObjectStorage(env),
    paymentProvider,
    rateLimiters: createRateLimiters({ redis }),
    healthChecks,
    ...(env.PASSWORD_BREACH_CHECK ? { passwordBreachCheck: new HibpPasswordCheck(logger) } : {}),
  });

  const server = createServer(app);
  const realtime = attachRealtime(server, {
    tokens,
    prisma,
    databaseUrl: env.DATABASE_URL,
    logger,
    corsOrigins: env.CORS_ORIGINS,
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    // e.g. EADDRINUSE / EACCES on startup: log clearly and exit so the orchestrator restarts us.
    logger.fatal({ err: error, port: env.PORT }, 'http server error');
    void prisma.$disconnect().finally(() => process.exit(1));
  });
  server.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, docs: env.ENABLE_API_DOCS ? '/api/docs' : 'disabled' },
      'api listening',
    );
  });

  // The worker processes background jobs; if it is down or stuck it cannot report that itself,
  // so the API watches the queue (every instance; Sentry groups the alerts into one issue).
  const watchOutbox = () => {
    outboxBacklog(prisma)
      .then(({ overdue, oldestDueAt }) => {
        if (overdue > 0) {
          alerts.critical(logger, 'outbox_backlog', 'background jobs are not being processed', {
            overdue,
            oldestDueAt: oldestDueAt?.toISOString(),
          });
        }
      })
      .catch((err: unknown) => logger.warn({ err }, 'outbox backlog check failed'));
  };
  const outboxTimer = setInterval(watchOutbox, OUTBOX_WATCH_INTERVAL_MS);
  outboxTimer.unref();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(outboxTimer);
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    void realtime.close();
    server.close((closeError) => {
      if (closeError) logger.error({ err: closeError }, 'error while closing http server');
      void Promise.allSettled([prisma.$disconnect(), redis?.quit()])
        .then((results) => {
          for (const result of results) {
            if (result.status === 'rejected') {
              logger.error({ err: result.reason }, 'error while closing a connection');
            }
          }
        })
        .then(() => alerts.flush())
        .finally(() => {
          logger.info('shutdown complete');
          process.exit(closeError ? 1 : 0);
        });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    alerts.exception(logger, reason, { kind: 'unhandledRejection' });
    shutdown('unhandledRejection');
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet (e.g. invalid env), so fall back to stderr.
  if (error instanceof EnvValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Fatal startup error: ${String(error)}\n`);
  }
  process.exit(1);
});
