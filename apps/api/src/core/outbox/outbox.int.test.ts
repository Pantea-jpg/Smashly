import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { createUser } from '../../../test/fixtures';
import { MemoryMailer } from '../../integrations/email/mailer';
import { runMaintenance } from '../../jobs/maintenance';
import { createOutboxHandlers } from './handlers';
import { alerts } from '../observability/alerts';
import {
  backoffMs,
  DEFAULT_DISPATCHER_OPTIONS,
  enqueueOutbox,
  OUTBOX_BACKLOG_AGE_MS,
  OutboxDispatcher,
  outboxBacklog,
} from './outbox';

const prisma = useTestDatabase();
const logger = pino({ level: 'silent' });

function dispatcher(mailer: MemoryMailer, options = {}) {
  return new OutboxDispatcher(
    prisma,
    createOutboxHandlers({ mailer, push: { deliver: () => Promise.reject(new Error('unused')) } }),
    logger,
    options,
  );
}

const resetJob = {
  to: 'anna@example.test',
  template: 'resetPassword' as const,
  language: 'nl' as const,
  params: { firstName: 'Anna', link: 'trainingwallet://reset-password?token=secret-token' },
};

describe('OutboxDispatcher', () => {
  it('delivers an email in the recipient language and redacts the one-time link', async () => {
    const mailer = new MemoryMailer();
    await enqueueOutbox(prisma, 'email.send', resetJob);

    expect(await dispatcher(mailer).runOnce()).toBe(1);

    expect(mailer.sent).toHaveLength(1);
    const [message] = mailer.sent;
    expect(message?.subject).toBe('Stel je wachtwoord opnieuw in');
    expect(message?.text).toContain('Hoi Anna,');
    expect(message?.html).toContain('reset-password?token=secret-token');

    const row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.processedAt).not.toBeNull();
    expect(JSON.stringify(row.payload)).not.toContain('secret-token');
  });

  it('escapes user-controlled values in HTML', async () => {
    const mailer = new MemoryMailer();
    await enqueueOutbox(prisma, 'email.send', {
      ...resetJob,
      language: 'en',
      params: { firstName: '<script>alert(1)</script>', link: resetJob.params.link },
    });
    await dispatcher(mailer).runOnce();
    expect(mailer.sent[0]?.html).not.toContain('<script>');
    expect(mailer.sent[0]?.html).toContain('&lt;script&gt;');
  });

  it('does not deliver events from a rolled-back transaction', async () => {
    const mailer = new MemoryMailer();
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueOutbox(tx, 'email.send', resetJob);
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect(await dispatcher(mailer).runOnce()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('retries with backoff after a failure, then succeeds', async () => {
    const mailer = new MemoryMailer();
    mailer.failNext = 1;
    await enqueueOutbox(prisma, 'email.send', resetJob);
    const worker = dispatcher(mailer);

    await worker.runOnce();
    let row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.attempts).toBe(1);
    expect(row.processedAt).toBeNull();
    expect(row.lastError).toContain('Simulated SMTP failure');
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());

    // Not yet due: nothing is claimed.
    expect(await worker.runOnce()).toBe(0);

    await prisma.outboxEvent.update({ where: { id: row.id }, data: { availableAt: new Date() } });
    await worker.runOnce();
    row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.processedAt).not.toBeNull();
    expect(mailer.sent).toHaveLength(1);
  });

  it('gives up after maxAttempts and raises an alert', async () => {
    const critical = vi.spyOn(alerts, 'critical');
    const mailer = new MemoryMailer();
    mailer.failNext = 99;
    await enqueueOutbox(prisma, 'email.send', resetJob);
    const worker = dispatcher(mailer, { maxAttempts: 2, baseBackoffMs: 0 });

    await worker.runOnce();
    await prisma.outboxEvent.updateMany({ data: { availableAt: new Date() } });
    await worker.runOnce();

    const row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.failedAt).not.toBeNull();
    expect(row.attempts).toBe(2);
    expect(critical).toHaveBeenCalledTimes(1);
    expect(critical).toHaveBeenCalledWith(
      expect.anything(),
      'outbox_event_failed',
      expect.any(String),
      expect.objectContaining({ outboxEventId: row.id, type: 'email.send', attempts: 2 }),
    );
    await prisma.outboxEvent.updateMany({ data: { availableAt: new Date() } });
    expect(await worker.runOnce()).toBe(0);
  });

  it('reports a backlog when due jobs wait longer than the threshold', async () => {
    const now = new Date();
    expect(await outboxBacklog(prisma, now)).toEqual({
      overdue: 0,
      failedLastDay: 0,
      oldestDueAt: null,
    });
    await enqueueOutbox(prisma, 'email.send', resetJob); // due now: not a backlog yet
    const old = new Date(now.getTime() - OUTBOX_BACKLOG_AGE_MS - 60_000);
    await enqueueOutbox(prisma, 'email.send', resetJob, { availableAt: old });
    await enqueueOutbox(prisma, 'email.send', resetJob, { availableAt: old });
    await prisma.outboxEvent.create({
      data: { type: 'email.send', payload: resetJob, availableAt: old, failedAt: now },
    });
    const report = await outboxBacklog(prisma, now);
    expect(report.overdue).toBe(2); // failed jobs are not "waiting"; they are counted separately
    expect(report.failedLastDay).toBe(1);
    expect(report.oldestDueAt?.getTime()).toBe(old.getTime());
  });

  it('marks unknown event types as failed', async () => {
    await prisma.outboxEvent.create({ data: { type: 'does.not.exist', payload: {} } });
    await dispatcher(new MemoryMailer()).runOnce();
    const row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.failedAt).not.toBeNull();
    expect(row.lastError).toContain('Unknown event type');
  });

  it('lets two workers share the queue without double delivery', async () => {
    const mailer = new MemoryMailer();
    for (let i = 0; i < 30; i += 1) {
      await enqueueOutbox(prisma, 'email.send', { ...resetJob, to: `user${i}@example.test` });
    }
    const a = dispatcher(mailer, { batchSize: 7 });
    const b = dispatcher(mailer, { batchSize: 7 });
    let processed = 0;
    for (let round = 0; round < 10; round += 1) {
      const [x, y] = await Promise.all([a.runOnce(), b.runOnce()]);
      processed += x + y;
    }
    expect(processed).toBe(30);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(30);
    expect(mailer.sent).toHaveLength(30);
  });
});

describe('backoffMs', () => {
  it('doubles and caps', () => {
    expect(backoffMs(1, DEFAULT_DISPATCHER_OPTIONS)).toBe(5_000);
    expect(backoffMs(2, DEFAULT_DISPATCHER_OPTIONS)).toBe(10_000);
    expect(backoffMs(30, DEFAULT_DISPATCHER_OPTIONS)).toBe(DEFAULT_DISPATCHER_OPTIONS.maxBackoffMs);
  });
});

describe('runMaintenance', () => {
  it('purges expired credentials and old processed events, keeping current ones', async () => {
    const user = await createUser(prisma);
    const now = new Date();
    const old = new Date(now.getTime() - 8 * 24 * 60 * 60_000);
    await prisma.refreshToken.createMany({
      data: [
        { userId: user.id, familyId: crypto.randomUUID(), tokenHash: 'old', expiresAt: old },
        {
          userId: user.id,
          familyId: crypto.randomUUID(),
          tokenHash: 'current',
          expiresAt: new Date(now.getTime() + 60_000),
        },
      ],
    });
    await prisma.outboxEvent.createMany({
      data: [
        { type: 'email.send', payload: {}, processedAt: old },
        { type: 'email.send', payload: {} },
      ],
    });

    const result = await runMaintenance(prisma, now);
    expect(result.refreshTokens).toBe(1);
    expect(result.outboxEvents).toBe(1);
    expect(await prisma.refreshToken.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });
});
