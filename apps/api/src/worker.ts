import { EnvValidationError, loadEnv } from './config/env';
import { createPrismaClient } from './core/db/prisma';
import { createLogger } from './core/logger/logger';
import { alerts, initObservability } from './core/observability/alerts';
import { createOutboxHandlers } from './core/outbox/handlers';
import { OutboxDispatcher } from './core/outbox/outbox';
import { createMailer } from './integrations/email/mailer';
import { StripePaymentProvider } from './integrations/payments/payment-provider';
import { createPushProvider } from './integrations/push/create-push-provider';
import { S3ObjectStorage } from './integrations/storage/object-storage';
import { runMaintenance } from './jobs/maintenance';
import { purgeOrphanAvatars } from './jobs/orphan-avatars';
import { SettingsService } from './modules/admin/settings.service';
import { PushService } from './modules/notifications/push.service';
import { ReminderJobs } from './modules/notifications/reminder-jobs';
import { PaymentsService } from './modules/payments/payments.service';
import { ReconciliationService } from './modules/reports/reconciliation.service';
import { AttendanceService } from './modules/trainings/attendance.service';
import { SeriesService } from './modules/trainings/series.service';
import { TrainingsService } from './modules/trainings/trainings.service';
import { LedgerService } from './modules/wallets/ledger.service';

const MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const PAYMENT_SWEEP_INTERVAL_MS = 5 * 60_000;
const RECONCILIATION_INTERVAL_MS = 24 * 60 * 60_000;
const TRAINING_JOBS_INTERVAL_MS = 60 * 60_000;
/** Short enough that a "2 hours before" reminder is at most 5 minutes late. */
const REMINDER_INTERVAL_MS = 5 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Background process: delivers outbox events (emails and pushes) and runs periodic jobs:
 * maintenance, the Stripe payment sweeper, the nightly ledger reconciliation, training and
 * debt reminders. Scale horizontally; event claiming uses SKIP LOCKED.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env, 'worker');
  if (!initObservability(env, 'worker')) logger.warn('SENTRY_DSN not set: alerts are only logged');
  const prisma = createPrismaClient(env.DATABASE_URL);
  const mailer = createMailer(env.SMTP_URL, env.EMAIL_FROM, logger);

  try {
    await mailer.verify?.();
  } catch (err) {
    // Not fatal: delivery is retried with backoff. Surface it loudly though.
    logger.error({ err }, 'SMTP connection check failed; emails will be retried');
  }

  const storage = new S3ObjectStorage(env);
  const maintain = () => {
    runMaintenance(prisma)
      .then((result) => logger.info({ result }, 'maintenance completed'))
      .catch((err: unknown) => alerts.exception(logger, err, { job: 'maintenance failed' }));
    purgeOrphanAvatars(prisma, storage)
      .then((result) => {
        if (result.deleted > 0) logger.info({ result }, 'orphaned profile pictures deleted');
      })
      .catch((err: unknown) =>
        alerts.exception(logger, err, { job: 'orphan avatar purge failed' }),
      );
  };
  maintain();
  const maintenanceTimer = setInterval(maintain, MAINTENANCE_INTERVAL_MS);

  const settings = new SettingsService(prisma);
  const pushProvider = createPushProvider(env, logger);
  const push = new PushService(prisma, pushProvider, settings, logger);
  const dispatcher = new OutboxDispatcher(prisma, createOutboxHandlers({ mailer, push }), logger);
  dispatcher.start();
  logger.info({ push: pushProvider.name }, 'worker started');

  // Payments whose webhook never arrived: ask Stripe directly.
  const ledger = new LedgerService(prisma, settings);
  const payments = new PaymentsService(
    prisma,
    ledger,
    settings,
    StripePaymentProvider.fromEnv(env),
    logger,
  );
  const sweep = () => {
    payments
      .sweep()
      .then((result) => {
        if (result.checked > 0) logger.info({ result }, 'payment sweep completed');
      })
      .catch((err: unknown) => alerts.exception(logger, err, { job: 'payment sweep failed' }));
  };
  const sweepTimer = setInterval(sweep, PAYMENT_SWEEP_INTERVAL_MS);

  // Recompute every wallet from the ledger. Mismatches are an alert, never auto-corrected.
  const reconciliation = new ReconciliationService(prisma);
  const reconcile = () => {
    reconciliation
      .run()
      .then((report) => {
        if (report.issues.length > 0) {
          alerts.critical(
            logger,
            'reconciliation_mismatch',
            'wallet totals differ from the ledger',
            {
              total: report.issues.length,
              issues: report.issues.slice(0, 20),
            },
          );
        } else {
          logger.info({ walletsChecked: report.walletsChecked }, 'reconciliation passed');
        }
      })
      .catch((err: unknown) =>
        alerts.exception(logger, err, { job: 'reconciliation failed to run' }),
      );
  };
  reconcile();
  const reconcileTimer = setInterval(reconcile, RECONCILIATION_INTERVAL_MS);

  // Hourly: remind admins about unfinalized trainings (D13, never auto-finalize) and keep
  // recurring series generated 12 weeks ahead (D7).
  const attendance = new AttendanceService(
    prisma,
    ledger,
    new TrainingsService(prisma, ledger, settings),
  );
  const series = new SeriesService(prisma);
  const trainingJobs = () => {
    attendance
      .remindUnfinalized()
      .then((n) => {
        if (n > 0) logger.info({ trainings: n }, 'finalization reminders checked');
      })
      .catch((err: unknown) =>
        alerts.exception(logger, err, { job: 'finalization reminder failed' }),
      );
    series
      .extendAll()
      .then((n) => {
        if (n > 0) logger.info({ created: n }, 'series sessions generated');
      })
      .catch((err: unknown) => alerts.exception(logger, err, { job: 'series extension failed' }));
  };
  trainingJobs();
  const trainingTimer = setInterval(trainingJobs, TRAINING_JOBS_INTERVAL_MS);

  // D22: training reminders 24 h / 2 h before, weekly debt reminders (pushed via the outbox).
  const reminders = new ReminderJobs(prisma);
  const remind = () => {
    reminders
      .trainingReminders()
      .then((n) => {
        if (n > 0) logger.info({ notifications: n }, 'training reminders created');
      })
      .catch((err: unknown) => alerts.exception(logger, err, { job: 'training reminders failed' }));
    reminders
      .debtReminders()
      .then((n) => {
        if (n > 0) logger.info({ notifications: n }, 'debt reminders created');
      })
      .catch((err: unknown) => alerts.exception(logger, err, { job: 'debt reminders failed' }));
  };
  remind();
  const reminderTimer = setInterval(remind, REMINDER_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    clearInterval(maintenanceTimer);
    clearInterval(sweepTimer);
    clearInterval(reconcileTimer);
    clearInterval(trainingTimer);
    clearInterval(reminderTimer);
    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    void dispatcher
      .stop()
      .then(() => Promise.allSettled([pushProvider.close?.(), prisma.$disconnect()]))
      .catch((err: unknown) => logger.error({ err }, 'error during worker shutdown'))
      .then(() => alerts.flush())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Fatal worker startup error: ${String(error)}\n`);
  }
  process.exit(1);
});
