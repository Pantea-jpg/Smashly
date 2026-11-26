import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser } from '../../../test/fixtures';
import { loginAs } from '../../../test/sessions';
import { runMaintenance } from '../../jobs/maintenance';

const prisma = useTestDatabase();
const { app } = buildTestApp({ prisma });
const TOKEN = 'AB'.repeat(32); // the app may send upper-case hex

async function signedIn() {
  const user = await createUser(prisma);
  return { ...user, session: await loginAs(app, user) };
}

const register = (auth: Record<string, string>, body: Record<string, unknown> = {}) =>
  request(app)
    .post('/api/v1/me/devices')
    .set(auth)
    .send({ token: TOKEN, platform: 'IOS', appVersion: '1.0.0', ...body });

describe('push device registration', () => {
  it('registers a token (normalised to lower case) and refreshes it on every launch', async () => {
    const m = await signedIn();
    const first = await register(m.session.auth);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      platform: 'IOS',
      provider: 'APNS',
      appVersion: '1.0.0',
    });

    const again = await register(m.session.auth, { appVersion: '1.1.0' });
    expect(again.body.data.id).toBe(first.body.data.id);
    const row = await prisma.deviceToken.findUniqueOrThrow({
      where: { token: TOKEN.toLowerCase() },
    });
    expect(row).toMatchObject({ userId: m.id, appVersion: '1.1.0', revokedAt: null });
  });

  it('moves a token to whoever signs in on that phone next', async () => {
    const a = await signedIn();
    const b = await signedIn();
    await register(a.session.auth);
    await register(b.session.auth);
    const row = await prisma.deviceToken.findUniqueOrThrow({
      where: { token: TOKEN.toLowerCase() },
    });
    expect(row.userId).toBe(b.id);
    expect(await prisma.deviceToken.count()).toBe(1);
  });

  it('unregisters on sign-out; only the owner can, and repeating it is harmless', async () => {
    const owner = await signedIn();
    const other = await signedIn();
    await register(owner.session.auth);

    await request(app).delete(`/api/v1/me/devices/${TOKEN}`).set(other.session.auth).expect(204);
    expect((await prisma.deviceToken.findFirstOrThrow()).revokedAt).toBeNull();

    await request(app).delete(`/api/v1/me/devices/${TOKEN}`).set(owner.session.auth).expect(204);
    await request(app).delete(`/api/v1/me/devices/${TOKEN}`).set(owner.session.auth).expect(204);
    expect((await prisma.deviceToken.findFirstOrThrow()).revokedAt).not.toBeNull();

    // Signing in again on the phone re-activates it.
    await register(owner.session.auth);
    expect((await prisma.deviceToken.findFirstOrThrow()).revokedAt).toBeNull();
  });

  it('rejects malformed tokens and other platforms', async () => {
    const m = await signedIn();
    expect((await register(m.session.auth, { token: 'not-a-token' })).status).toBe(400);
    expect((await register(m.session.auth, { platform: 'ANDROID' })).status).toBe(400);
  });

  it('"sign out everywhere" stops pushes to every phone', async () => {
    const m = await signedIn();
    await register(m.session.auth);
    await request(app).post('/api/v1/auth/logout-all').set(m.session.auth).expect(204);
    expect((await prisma.deviceToken.findFirstOrThrow()).revokedAt).not.toBeNull();
  });

  it('maintenance revokes abandoned tokens and purges long-revoked ones', async () => {
    const m = await createUser(prisma);
    const day = 24 * 60 * 60_000;
    const now = new Date();
    await prisma.deviceToken.createMany({
      data: [
        { userId: m.id, platform: 'IOS', provider: 'APNS', token: '1'.repeat(64), lastSeenAt: now },
        {
          userId: m.id,
          platform: 'IOS',
          provider: 'APNS',
          token: '2'.repeat(64),
          lastSeenAt: new Date(now.getTime() - 91 * day),
        },
        {
          userId: m.id,
          platform: 'IOS',
          provider: 'APNS',
          token: '3'.repeat(64),
          lastSeenAt: new Date(now.getTime() - 60 * day),
          revokedAt: new Date(now.getTime() - 31 * day),
        },
      ],
    });
    const result = await runMaintenance(prisma, now);
    expect(result).toMatchObject({ staleDevices: 1, devicesPurged: 1 });
    const rows = await prisma.deviceToken.findMany({ orderBy: { token: 'asc' } });
    expect(rows.map((r) => [r.token[0], r.revokedAt !== null])).toEqual([
      ['1', false],
      ['2', true],
    ]);
  });
});
