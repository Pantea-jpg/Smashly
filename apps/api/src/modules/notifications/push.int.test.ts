import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { createUser } from '../../../test/fixtures';
import { testClock } from '../../../test/trainings';
import type { PushJob } from '../../core/outbox/outbox';
import { FakePushProvider } from '../../integrations/push/push-provider';
import { SettingsService } from '../admin/settings.service';
import { type NotifyInput, notifyUsersNow as notifyUsers } from './notify';
import { PushService } from './push.service';

const prisma = useTestDatabase();
const provider = new FakePushProvider();
// 15:00 in Amsterdam (UTC+1): outside the default 22:00–08:00 quiet hours.
const clock = testClock(Date.parse('2026-11-25T14:00:00Z'));
const push = new PushService(
  prisma,
  provider,
  new SettingsService(prisma),
  pino({ level: 'silent' }),
  clock.now,
);

let tokenCounter = 0;
const newToken = () => {
  tokenCounter += 1;
  return tokenCounter.toString(16).padStart(64, '0');
};

async function memberWithDevice(
  options: { language?: 'en' | 'nl'; timezone?: string; devices?: number } = {},
) {
  const user = await createUser(prisma);
  await prisma.userProfile.update({
    where: { userId: user.id },
    data: {
      preferredLanguage: options.language ?? 'en',
      timezone: options.timezone ?? 'Europe/Amsterdam',
    },
  });
  const tokens: string[] = [];
  for (let i = 0; i < (options.devices ?? 1); i += 1) {
    const token = newToken();
    tokens.push(token);
    await prisma.deviceToken.create({
      data: { userId: user.id, platform: 'IOS', provider: 'APNS', token, lastSeenAt: clock.now() },
    });
  }
  return { ...user, tokens };
}

const charged = (userId: string, key = 'charge-1'): NotifyInput => ({
  userIds: [userId],
  type: 'TRAINING_CHARGED',
  category: 'PAYMENTS',
  params: {
    trainingId: '0193a000-0000-7000-8000-000000000001',
    title: 'Tuesday club',
    amountMinor: 1250,
    currency: 'EUR',
  },
  dedupeKey: key,
});

/** The pending push jobs in the outbox, oldest first. */
async function pushJobs() {
  const rows = await prisma.outboxEvent.findMany({
    where: { type: 'notification.push', processedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    availableAt: r.availableAt,
    job: r.payload as unknown as PushJob,
  }));
}

/** Delivers every pending push job, like the worker does, and marks it processed. */
async function drain() {
  for (const { id, job } of await pushJobs()) {
    await push.deliver(job);
    await prisma.outboxEvent.update({ where: { id }, data: { processedAt: new Date() } });
  }
}

beforeEach(() => {
  provider.reset();
  clock.set(Date.parse('2026-11-25T14:00:00Z'));
});

describe('push pipeline', () => {
  it('creates one notification, one outbox job and one push per device, deduplicated', async () => {
    const m = await memberWithDevice({ devices: 2 });
    expect(await notifyUsers(prisma, charged(m.id))).toHaveLength(1);
    expect(await notifyUsers(prisma, charged(m.id))).toEqual([]); // same dedupe key
    expect(await pushJobs()).toHaveLength(1);

    await drain();
    expect(provider.sent.map((p) => p.token).sort()).toEqual([...m.tokens].sort());
    expect(provider.sent[0]).toMatchObject({
      title: 'Training charged',
      body: '€12.50 for Tuesday club.',
      badge: 1,
      threadId: 'PAYMENTS',
      data: { type: 'TRAINING_CHARGED', trainingId: '0193a000-0000-7000-8000-000000000001' },
    });
    expect(await prisma.notificationDelivery.count({ where: { status: 'SENT' } })).toBe(2);
  });

  it('renders each recipient in their own language and timezone', async () => {
    const nl = await memberWithDevice({ language: 'nl' });
    const en = await memberWithDevice({ language: 'en', timezone: 'Europe/London' });
    await notifyUsers(prisma, {
      userIds: [nl.id, en.id],
      type: 'TRAINING_REMINDER',
      category: 'REMINDERS',
      params: { title: 'Dinsdag', startsAt: '2026-11-25T18:00:00Z', window: '2h' },
      dedupeKey: 'reminder:2h:t1',
    });
    await drain();
    const byToken = new Map(provider.sent.map((p) => [p.token, p]));
    expect(byToken.get(nl.tokens[0]!)).toMatchObject({
      title: 'Training begint zo',
      body: 'Dinsdag begint om 19:00.',
    });
    expect(byToken.get(en.tokens[0]!)).toMatchObject({
      title: 'Training starts soon',
      body: 'Dinsdag starts at 18:00.',
    });
    // A reminder is useless after the start: APNs may drop it then.
    expect(byToken.get(nl.tokens[0]!)?.expiresAt?.toISOString()).toBe('2026-11-25T18:00:00.000Z');
  });

  it('skips a category the member turned off, but keeps the in-app notification', async () => {
    const m = await memberWithDevice();
    await prisma.notificationPreference.create({
      data: { userId: m.id, category: 'PAYMENTS', pushEnabled: false },
    });
    await notifyUsers(prisma, charged(m.id));
    await notifyUsers(prisma, {
      userIds: [m.id],
      type: 'DEBT_REMINDER',
      category: 'REMINDERS',
      params: { amountMinor: 500, currency: 'EUR' },
      dedupeKey: 'debt',
    });
    await drain();
    expect(provider.sent.map((p) => p.title)).toEqual(['Outstanding balance']);
    expect(await prisma.notification.count({ where: { userId: m.id } })).toBe(2);
    expect(
      await prisma.notificationDelivery.findFirst({ where: { status: 'SKIPPED' } }),
    ).toMatchObject({ error: 'disabled_by_preference' });
  });

  it('defers pushes during quiet hours until they end, in local time', async () => {
    const m = await memberWithDevice();
    clock.set(Date.parse('2026-11-25T22:30:00Z')); // 23:30 in Amsterdam
    await notifyUsers(prisma, charged(m.id));
    await drain();
    expect(provider.sent).toHaveLength(0);
    const [deferred] = await pushJobs();
    expect(deferred?.job.deferred).toBe(true);
    expect(deferred?.availableAt.toISOString()).toBe('2026-11-26T07:00:00.000Z'); // 08:00 local

    clock.set(Date.parse('2026-11-26T07:01:00Z'));
    await drain();
    expect(provider.sent).toHaveLength(1);
  });

  it('does not deliver a deferred push the member already read in the app', async () => {
    const m = await memberWithDevice();
    clock.set(Date.parse('2026-11-25T22:30:00Z'));
    const [id] = await notifyUsers(prisma, charged(m.id));
    await drain();
    await prisma.notification.update({ where: { id: id! }, data: { readAt: new Date() } });
    clock.set(Date.parse('2026-11-26T07:01:00Z'));
    await drain();
    expect(provider.sent).toHaveLength(0);
    expect(await prisma.notificationDelivery.findFirst()).toMatchObject({
      status: 'SKIPPED',
      error: 'read_during_quiet_hours',
    });
  });

  it('sends payment confirmations even during quiet hours (D22)', async () => {
    const m = await memberWithDevice();
    clock.set(Date.parse('2026-11-25T22:30:00Z'));
    await notifyUsers(prisma, {
      userIds: [m.id],
      type: 'TOP_UP_SUCCEEDED',
      category: 'PAYMENTS',
      params: { amountMinor: 2500, currency: 'EUR' },
      dedupeKey: 'topup',
    });
    await drain();
    expect(provider.sent.map((p) => p.body)).toEqual(['€25.00 has been added to your wallet.']);
  });

  it('sends at any hour when quiet hours are switched off', async () => {
    await new SettingsService(prisma).set('notifications.quietHours', null, null);
    const m = await memberWithDevice();
    clock.set(Date.parse('2026-11-25T22:30:00Z'));
    await notifyUsers(prisma, charged(m.id));
    await drain();
    expect(provider.sent).toHaveLength(1);
  });

  it('revokes a token APNs reports as unregistered (410) and never uses it again', async () => {
    const m = await memberWithDevice({ devices: 2 });
    const [dead, alive] = m.tokens as [string, string];
    provider.respond(dead, { ok: false, reason: 'Unregistered', unregistered: true });
    await notifyUsers(prisma, charged(m.id, 'a'));
    await drain();
    expect(provider.sent.map((p) => p.token)).toEqual([alive]);
    expect(
      (await prisma.deviceToken.findUniqueOrThrow({ where: { token: dead } })).revokedAt,
    ).not.toBeNull();

    provider.reset();
    await notifyUsers(prisma, charged(m.id, 'b'));
    await drain();
    expect(provider.sent.map((p) => p.token)).toEqual([alive]);
  });

  it('retries a transient failure without pushing twice to devices that already got it', async () => {
    const m = await memberWithDevice({ devices: 2 });
    const [flaky, ok] = m.tokens as [string, string];
    provider.respond(flaky, { ok: false, reason: 'ServiceUnavailable', unregistered: false });
    await notifyUsers(prisma, charged(m.id));
    const job = (await pushJobs())[0]!.job;
    await expect(push.deliver(job)).rejects.toThrow(/push delivery failed/);
    expect(provider.sent.map((p) => p.token)).toEqual([ok]);

    provider.reset(); // APNs is back
    await push.deliver(job); // the outbox retry
    expect(provider.sent.map((p) => p.token)).toEqual([flaky]);
    expect(await prisma.notificationDelivery.count({ where: { status: 'SENT' } })).toBe(2);
  });

  it('sends nothing to inactive members or members without devices', async () => {
    const inactive = await memberWithDevice();
    await prisma.user.update({ where: { id: inactive.id }, data: { status: 'INACTIVE' } });
    const noDevice = await createUser(prisma);
    await notifyUsers(prisma, { ...charged(inactive.id), userIds: [inactive.id, noDevice.id] });
    await drain();
    expect(provider.sent).toHaveLength(0);
    expect(await prisma.notificationDelivery.count()).toBe(0);
  });

  it('drops a deferred training reminder once the training has started', async () => {
    const m = await memberWithDevice();
    clock.set(Date.parse('2026-11-26T05:00:00Z')); // 06:00 local, quiet until 08:00
    await notifyUsers(prisma, {
      userIds: [m.id],
      type: 'TRAINING_REMINDER',
      category: 'REMINDERS',
      params: { title: 'Early swim', startsAt: '2026-11-26T06:30:00Z', window: '2h' },
      dedupeKey: 'reminder:2h:early',
    });
    await drain();
    clock.set(Date.parse('2026-11-26T07:00:00Z'));
    await drain();
    expect(provider.sent).toHaveLength(0);
    expect(await prisma.notificationDelivery.findFirst()).toMatchObject({ error: 'expired' });
  });
});
