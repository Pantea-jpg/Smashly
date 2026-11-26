import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { REALTIME_PATH } from '@tw/contracts';
import { pino } from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, inject } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser, TEST_TOKEN_CONFIG } from '../../../test/fixtures';
import { loginAs } from '../../../test/sessions';
import { key } from '../../../test/trainings';
import { TokenService } from '../../core/auth/tokens';
import { emitRealtime, rooms } from './realtime';
import { attachRealtime, type RealtimeServer } from './realtime.server';

const prisma = useTestDatabase();
const { app, tokens } = buildTestApp({ prisma });
const server = createServer(app);
let realtime: RealtimeServer;
let url: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  realtime = attachRealtime(server, {
    tokens,
    prisma,
    databaseUrl: inject('databaseUrl'),
    logger: pino({ level: 'silent' }),
    corsOrigins: [],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  await realtime.ready;
});

afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});

afterAll(async () => {
  await realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function open(token: string): Socket {
  const socket = connect(url, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  return socket;
}

async function connected(token: string): Promise<Socket> {
  const socket = open(token);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

/** Collects every event a socket receives. */
function recorder(socket: Socket) {
  const events: { event: string; data: unknown }[] = [];
  socket.onAny((event: string, data: unknown) => events.push({ event, data }));
  return events;
}

const waitFor = async (check: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting for realtime events');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('realtime (Socket.IO)', () => {
  it('rejects a handshake without a valid token', async () => {
    const socket = open('not-a-token');
    const error = await new Promise<Error & { data?: { code?: string } }>((resolve) =>
      socket.once('connect_error', resolve),
    );
    expect(error.data?.code).toBe('UNAUTHENTICATED');
  });

  it('pushes wallet and notification events to the member, activity to admins, after commit', async () => {
    const admin = await createUser(prisma, { role: 'ADMIN' });
    const member = await createUser(prisma);
    const other = await createUser(prisma);
    const adminSession = await loginAs(app, admin);
    const memberEvents = recorder(await connected((await loginAs(app, member)).accessToken));
    const otherEvents = recorder(await connected((await loginAs(app, other)).accessToken));
    const adminEvents = recorder(await connected(adminSession.accessToken));

    await request(app)
      .post(`/api/v1/admin/users/${member.id}/cash-payments`)
      .set(adminSession.auth)
      .set(key())
      .send({ amountMinor: 2500 })
      .expect(201);

    await waitFor(() => memberEvents.length >= 2 && adminEvents.length >= 1);
    expect(memberEvents.map((e) => e.event).sort()).toEqual([
      'notification.created',
      'wallet.updated',
    ]);
    expect(memberEvents.find((e) => e.event === 'wallet.updated')?.data).toEqual({
      userId: member.id,
    });
    expect(adminEvents).toContainEqual({ event: 'admin.activity', data: { userId: member.id } });
    // Nobody else hears about someone else's wallet.
    expect(otherEvents).toEqual([]);
  });

  it('broadcasts training changes to every member', async () => {
    const admin = await createUser(prisma, { role: 'ADMIN' });
    const member = await createUser(prisma);
    const events = recorder(await connected((await loginAs(app, member)).accessToken));
    const startsAt = new Date(Date.now() + 48 * 3_600_000);
    const res = await request(app)
      .post('/api/v1/admin/trainings')
      .set((await loginAs(app, admin)).auth)
      .send({
        title: 'Tuesday club',
        location: 'Hall A',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
        defaultPriceMinor: 1000,
      })
      .expect(201);
    await waitFor(() => events.some((e) => e.event === 'training.updated'));
    expect(events).toContainEqual({
      event: 'training.updated',
      data: { trainingId: res.body.data.id },
    });
  });

  it('never announces a change that rolled back', async () => {
    const member = await createUser(prisma);
    const events = recorder(await connected((await loginAs(app, member)).accessToken));
    await expect(
      prisma.$transaction(async (tx) => {
        await emitRealtime(tx, {
          room: rooms.user(member.id),
          event: 'wallet.updated',
          data: { userId: 'rolled-back' },
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await emitRealtime(prisma, {
      room: rooms.user(member.id),
      event: 'wallet.updated',
      data: { userId: 'committed' },
    });
    await waitFor(() => events.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(events.map((e) => e.data)).toEqual([{ userId: 'committed' }]);
  });

  it('closes the socket when the access token expires', async () => {
    const member = await createUser(prisma);
    const shortLived = new TokenService({ ...TEST_TOKEN_CONFIG, ACCESS_TOKEN_TTL_SECONDS: 1 });
    const { token } = await shortLived.signAccessToken({
      userId: member.id,
      role: 'USER',
      sessionId: 'test-session',
      tokenVersion: 0,
    });
    const socket = await connected(token);
    const reason = await new Promise<string>((resolve) => socket.once('disconnect', resolve));
    expect(reason).toBe('io server disconnect');
  });

  it('refuses accounts that were deactivated', async () => {
    const member = await createUser(prisma);
    const session = await loginAs(app, member);
    await prisma.user.update({ where: { id: member.id }, data: { status: 'INACTIVE' } });
    const socket = open(session.accessToken);
    const error = await new Promise<Error & { data?: { code?: string } }>((resolve) =>
      socket.once('connect_error', resolve),
    );
    expect(error.data?.code).toBe('ACCOUNT_INACTIVE');
  });
});
