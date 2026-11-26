import type { Language } from '@tw/i18n';
import type { Logger } from '../logger/logger';
import { type Db, type Prisma, type PrismaClient } from '../db/prisma';
import { alerts } from '../observability/alerts';

/** A job still waiting this long after it became due means the worker is down or stuck. */
export const OUTBOX_BACKLOG_AGE_MS = 15 * 60_000;

/**
 * Health of the background queue: jobs overdue by more than OUTBOX_BACKLOG_AGE_MS, and jobs
 * that failed permanently in the last 24 hours. Checked by the worker every few minutes.
 */
export async function outboxBacklog(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<{ overdue: number; failedLastDay: number; oldestDueAt: Date | null }> {
  const overdueWhere = {
    processedAt: null,
    failedAt: null,
    availableAt: { lt: new Date(now.getTime() - OUTBOX_BACKLOG_AGE_MS) },
  };
  const [overdue, failedLastDay, oldest] = await Promise.all([
    prisma.outboxEvent.count({ where: overdueWhere }),
    prisma.outboxEvent.count({
      where: { failedAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } },
    }),
    prisma.outboxEvent.findFirst({
      where: overdueWhere,
      orderBy: { availableAt: 'asc' },
      select: { availableAt: true },
    }),
  ]);
  return { overdue, failedLastDay, oldestDueAt: oldest?.availableAt ?? null };
}

// ── Event catalogue ─────────────────────────────────────────────────────────

export type EmailTemplate = 'verifyEmail' | 'resetPassword' | 'passwordChanged' | 'accountApproved';

export interface EmailJob {
  to: string;
  template: EmailTemplate;
  language: Language;
  params: { firstName: string; link?: string };
}

/** Push delivery for notifications created in the same transaction. */
export interface PushJob {
  notificationIds: string[];
  /** Re-queued at the end of quiet hours (D22). */
  deferred?: boolean;
}

/** Every outbox event type and its payload. Add new side effects here. */
export interface OutboxEventMap {
  'email.send': EmailJob;
  'notification.push': PushJob;
}
export type OutboxEventType = keyof OutboxEventMap;

/**
 * Records a side effect in the SAME transaction as the business change. It is delivered by
 * the worker only if the transaction commits, and retried until it succeeds or gives up.
 */
export async function enqueueOutbox<T extends OutboxEventType>(
  db: Db,
  type: T,
  payload: OutboxEventMap[T],
  options: { availableAt?: Date } = {},
): Promise<void> {
  await db.outboxEvent.create({
    data: {
      type,
      payload: payload as unknown as Prisma.InputJsonValue,
      ...(options.availableAt ? { availableAt: options.availableAt } : {}),
    },
  });
}

// ── Dispatcher (runs in the worker process) ─────────────────────────────────

export interface OutboxHandler<T extends OutboxEventType> {
  handle: (payload: OutboxEventMap[T]) => Promise<void>;
  /** Removes secrets (e.g. one-time links) from the stored payload once delivered. */
  redact?: (payload: OutboxEventMap[T]) => unknown;
}

export type OutboxHandlers = { [K in OutboxEventType]: OutboxHandler<K> };

export interface DispatcherOptions {
  batchSize: number;
  maxAttempts: number;
  /** How long a claimed event is hidden from other workers while being processed. */
  leaseMs: number;
  pollIntervalMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_DISPATCHER_OPTIONS: DispatcherOptions = {
  batchSize: 20,
  maxAttempts: 10,
  leaseMs: 5 * 60_000,
  pollIntervalMs: 1_000,
  baseBackoffMs: 5_000,
  maxBackoffMs: 60 * 60_000,
};

interface ClaimedEvent {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

/** Exponential backoff: 5s, 10s, 20s ... capped at maxBackoffMs. */
export function backoffMs(attempt: number, options: DispatcherOptions): number {
  return Math.min(options.baseBackoffMs * 2 ** Math.max(0, attempt - 1), options.maxBackoffMs);
}

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;
  private stopped = true;
  private readonly options: DispatcherOptions;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly handlers: OutboxHandlers,
    private readonly logger: Logger,
    options: Partial<DispatcherOptions> = {},
  ) {
    this.options = { ...DEFAULT_DISPATCHER_OPTIONS, ...options };
  }

  /**
   * Claims a batch with FOR UPDATE SKIP LOCKED (safe with several workers), pushes their
   * availability forward by the lease, then processes them outside any transaction.
   * Returns the number of events processed.
   */
  async runOnce(): Promise<number> {
    const leaseUntil = new Date(Date.now() + this.options.leaseMs);
    const claimed = await this.prisma.$queryRaw<ClaimedEvent[]>`
      UPDATE outbox_events
         SET attempts = attempts + 1, available_at = ${leaseUntil}
       WHERE id IN (
         SELECT id FROM outbox_events
          WHERE processed_at IS NULL AND failed_at IS NULL AND available_at <= now()
          ORDER BY available_at
          LIMIT ${this.options.batchSize}
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, type, payload, attempts`;

    for (const event of claimed) {
      await this.process(event);
    }
    return claimed.length;
  }

  private async process(event: ClaimedEvent): Promise<void> {
    const handler = this.handlers[event.type as OutboxEventType] as
      OutboxHandler<OutboxEventType> | undefined;
    const log = this.logger.child({
      outboxEventId: event.id,
      type: event.type,
      attempt: event.attempts,
    });

    if (!handler) {
      log.error('no handler for outbox event type; marking failed');
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { failedAt: new Date(), lastError: `Unknown event type: ${event.type}` },
      });
      return;
    }

    try {
      const payload = event.payload as OutboxEventMap[OutboxEventType];
      await handler.handle(payload);
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          processedAt: new Date(),
          lastError: null,
          ...(handler.redact ? { payload: handler.redact(payload) as Prisma.InputJsonValue } : {}),
        },
      });
      log.debug('outbox event processed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const giveUp = event.attempts >= this.options.maxAttempts;
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: giveUp
          ? { failedAt: new Date(), lastError: message.slice(0, 2000) }
          : {
              availableAt: new Date(Date.now() + backoffMs(event.attempts, this.options)),
              lastError: message.slice(0, 2000),
            },
      });
      if (giveUp) {
        alerts.critical(log, 'outbox_event_failed', 'a background job failed permanently', {
          outboxEventId: event.id,
          type: event.type,
          attempts: event.attempts,
          error: message.slice(0, 300),
        });
      } else {
        log.warn({ err: error }, 'outbox event failed; will retry');
      }
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.running = this.runOnce().catch((error: unknown) => {
        this.logger.error({ err: error }, 'outbox poll failed');
        return 0;
      });
      void this.running.then((count) => {
        if (this.stopped) return;
        // Drain quickly while there is work; otherwise wait for the poll interval.
        this.timer = setTimeout(tick, count > 0 ? 0 : this.options.pollIntervalMs);
      });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
