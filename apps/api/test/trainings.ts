import { randomUUID } from 'node:crypto';
import type { AdminTraining } from '@tw/contracts';
import request from 'supertest';
import type { App } from '../src/app';
import type { PrismaClient } from '../src/core/db/prisma';
import { createUser } from './fixtures';
import { loginAs, type TestSession } from './sessions';

export const HOUR = 3_600_000;

/** A controllable clock shared by the app and the token service. */
export function testClock(start = Date.now()) {
  let current = start;
  return {
    now: () => new Date(current),
    get ms() {
      return current;
    },
    set(ms: number) {
      current = ms;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}

export async function createTrainingViaApi(
  app: App,
  admin: TestSession,
  input: { startsInMs: number; clockMs: number; durationMs?: number } & Record<string, unknown>,
) {
  const { startsInMs, clockMs, durationMs = HOUR, ...rest } = input;
  const startsAt = new Date(clockMs + startsInMs);
  const res = await request(app)
    .post('/api/v1/admin/trainings')
    .set(admin.auth)
    .send({
      title: 'Tuesday training',
      location: 'Hall A',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + durationMs).toISOString(),
      defaultPriceMinor: 1000,
      ...rest,
    });
  if (res.status !== 201)
    throw new Error(`create training failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.data as AdminTraining;
}

export async function member(prisma: PrismaClient, app: App) {
  const user = await createUser(prisma);
  return { ...user, session: await loginAs(app, user) };
}

export const key = () => ({ 'idempotency-key': `k-${randomUUID()}` });
