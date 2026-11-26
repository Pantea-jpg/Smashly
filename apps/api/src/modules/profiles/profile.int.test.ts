import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser, TEST_PASSWORD } from '../../../test/fixtures';
import { loginAs, type TestSession } from '../../../test/sessions';

const prisma = useTestDatabase();
const { app, storage } = buildTestApp({ prisma });

let user: { id: string; email: string; password: string };
let session: TestSession;

beforeEach(async () => {
  storage.objects.clear();
  user = await createUser(prisma);
  session = await loginAs(app, user);
});

describe('profile', () => {
  it('GET /me/profile returns the profile without secrets', async () => {
    const res = await request(app).get('/api/v1/me/profile').set(session.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: user.id,
      email: user.email,
      phone: null,
      avatarUrl: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
  });

  it('PATCH /me/profile updates fields, clears the phone with null, and audits field names only', async () => {
    await request(app)
      .patch('/api/v1/me/profile')
      .set(session.auth)
      .send({ phone: '+31612345678' })
      .expect(200);
    const res = await request(app)
      .patch('/api/v1/me/profile')
      .set(session.auth)
      .send({ firstName: '  Anna ', preferredLanguage: 'nl', phone: null });
    expect(res.body.data).toMatchObject({
      firstName: 'Anna',
      preferredLanguage: 'nl',
      phone: null,
    });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'profile.updated' },
      orderBy: { id: 'desc' },
    });
    expect(JSON.stringify(audit.after)).not.toContain('Anna');
  });

  it('rejects an empty update and invalid values', async () => {
    expect((await request(app).patch('/api/v1/me/profile').set(session.auth).send({})).status).toBe(
      400,
    );
    expect(
      (await request(app).patch('/api/v1/me/profile').set(session.auth).send({ phone: '0612' }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch('/api/v1/me/profile')
          .set(session.auth)
          .send({ email: 'x@y.z', firstName: 'A' })
      ).body.data.email,
    ).toBe(user.email);
  });
});

describe('PATCH /me/password', () => {
  it('requires the current password', async () => {
    const res = await request(app)
      .patch('/api/v1/me/password')
      .set(session.auth)
      .send({ currentPassword: 'wrong password!', newPassword: 'a new long passphrase' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('changes the password, ends other sessions and returns a fresh one', async () => {
    const otherDevice = await loginAs(app, user);
    const res = await request(app)
      .patch('/api/v1/me/password')
      .set(session.auth)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a new long passphrase' });
    expect(res.status).toBe(200);
    const fresh = res.body.data.tokens.accessToken as string;

    expect(
      (await request(app).get('/api/v1/me').set('authorization', `Bearer ${fresh}`)).status,
    ).toBe(200);
    expect((await request(app).get('/api/v1/me').set(otherDevice.auth)).status).toBe(401);
    expect((await request(app).get('/api/v1/me').set(session.auth)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD })
      ).status,
    ).toBe(401);
    const emails = await prisma.outboxEvent.findMany();
    expect(emails.map((e) => (e.payload as { template: string }).template)).toContain(
      'passwordChanged',
    );
  });
});

describe('notification preferences', () => {
  it('defaults every category to enabled and stores changes', async () => {
    const defaults = await request(app)
      .get('/api/v1/me/notification-preferences')
      .set(session.auth);
    expect(defaults.body.data).toEqual([
      { category: 'TRAININGS', pushEnabled: true },
      { category: 'PAYMENTS', pushEnabled: true },
      { category: 'REMINDERS', pushEnabled: true },
    ]);
    const res = await request(app)
      .put('/api/v1/me/notification-preferences')
      .set(session.auth)
      .send([{ category: 'REMINDERS', pushEnabled: false }]);
    expect(res.body.data).toContainEqual({ category: 'REMINDERS', pushEnabled: false });
    expect(res.body.data).toContainEqual({ category: 'PAYMENTS', pushEnabled: true });
  });

  it('rejects duplicate or unknown categories', async () => {
    const dup = await request(app)
      .put('/api/v1/me/notification-preferences')
      .set(session.auth)
      .send([
        { category: 'PAYMENTS', pushEnabled: false },
        { category: 'PAYMENTS', pushEnabled: true },
      ]);
    expect(dup.status).toBe(400);
    const unknown = await request(app)
      .put('/api/v1/me/notification-preferences')
      .set(session.auth)
      .send([{ category: 'MARKETING', pushEnabled: true }]);
    expect(unknown.status).toBe(400);
  });
});

describe('profile picture', () => {
  async function upload(contentType = 'image/jpeg', sizeBytes = 120_000) {
    const res = await request(app)
      .post('/api/v1/me/avatar/upload-url')
      .set(session.auth)
      .send({ contentType, sizeBytes });
    expect(res.status).toBe(200);
    const { objectKey } = res.body.data as { objectKey: string };
    return objectKey;
  }

  it('issues a presigned upload under the user prefix, then confirms it', async () => {
    const objectKey = await upload();
    expect(objectKey).toMatch(new RegExp(`^avatars/${user.id}/[0-9a-f-]+\\.jpg$`));
    storage.put(objectKey, { contentType: 'image/jpeg', contentLength: 120_000 });

    const res = await request(app).put('/api/v1/me/avatar').set(session.auth).send({ objectKey });
    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toContain(encodeURIComponent(objectKey));
  });

  it('replacing deletes the old object; removing clears it', async () => {
    const first = await upload();
    storage.put(first, { contentType: 'image/jpeg', contentLength: 1000 });
    await request(app)
      .put('/api/v1/me/avatar')
      .set(session.auth)
      .send({ objectKey: first })
      .expect(200);
    const second = await upload('image/png');
    storage.put(second, { contentType: 'image/png', contentLength: 1000 });
    await request(app)
      .put('/api/v1/me/avatar')
      .set(session.auth)
      .send({ objectKey: second })
      .expect(200);
    expect(storage.objects.has(first)).toBe(false);

    const removed = await request(app).delete('/api/v1/me/avatar').set(session.auth);
    expect(removed.body.data.avatarUrl).toBeNull();
    expect(storage.objects.size).toBe(0);
  });

  it('refuses other users objects, missing uploads, wrong types and oversize files', async () => {
    const foreign = `avatars/${randomUUID()}/x.jpg`;
    storage.put(foreign, { contentType: 'image/jpeg', contentLength: 10 });
    expect(
      (await request(app).put('/api/v1/me/avatar').set(session.auth).send({ objectKey: foreign }))
        .status,
    ).toBe(400);

    const missing = await upload();
    expect(
      (await request(app).put('/api/v1/me/avatar').set(session.auth).send({ objectKey: missing }))
        .status,
    ).toBe(400);

    const sneaky = await upload();
    storage.put(sneaky, { contentType: 'text/html', contentLength: 10 });
    expect(
      (await request(app).put('/api/v1/me/avatar').set(session.auth).send({ objectKey: sneaky }))
        .status,
    ).toBe(400);
    expect(storage.objects.has(sneaky)).toBe(false);

    expect(
      (
        await request(app)
          .post('/api/v1/me/avatar/upload-url')
          .set(session.auth)
          .send({ contentType: 'image/gif', sizeBytes: 10 })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/v1/me/avatar/upload-url')
          .set(session.auth)
          .send({ contentType: 'image/jpeg', sizeBytes: 6 * 1024 * 1024 })
      ).status,
    ).toBe(400);
  });
});

describe('GET /me/export', () => {
  it('contains the personal data and no secrets', async () => {
    const res = await request(app).get('/api/v1/me/export').set(session.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.account).toMatchObject({ id: user.id, email: user.email });
    expect(res.body.data.wallets).toHaveLength(1);
    expect(res.body.data.sessions.length).toBeGreaterThan(0);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/passwordHash|argon2|tokenHash|tokenVersion/);
    expect(await prisma.auditLog.count({ where: { action: 'profile.data_exported' } })).toBe(1);
  });
});

describe('DELETE /me (account deletion)', () => {
  it('requires the password', async () => {
    const res = await request(app)
      .delete('/api/v1/me')
      .set(session.auth)
      .send({ password: 'wrong password!' });
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('is refused while the wallet holds money or debt', async () => {
    await prisma.wallet.updateMany({ where: { userId: user.id }, data: { balanceMinor: 500 } });
    const res = await request(app)
      .delete('/api/v1/me')
      .set(session.auth)
      .send({ password: TEST_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_HAS_BALANCE_OR_DEBT');
  });

  it('anonymises personal data, ends sessions, frees the email and keeps financial records', async () => {
    await prisma.userProfile.update({
      where: { userId: user.id },
      data: { phone: '+31612345678', avatarKey: `avatars/${user.id}/a.jpg` },
    });
    storage.put(`avatars/${user.id}/a.jpg`, { contentType: 'image/jpeg', contentLength: 10 });
    const wallet = await prisma.wallet.findFirstOrThrow({ where: { userId: user.id } });

    const res = await request(app)
      .delete('/api/v1/me')
      .set(session.auth)
      .send({ password: TEST_PASSWORD });
    expect(res.status).toBe(204);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { profile: true },
    });
    expect(row.email).toBe(`deleted+${user.id}@deleted.invalid`);
    expect(row.status).toBe('INACTIVE');
    expect(row.deletedAt).not.toBeNull();
    expect(row.profile).toMatchObject({
      firstName: 'Deleted',
      lastName: 'user',
      phone: null,
      avatarKey: null,
    });
    expect(storage.objects.size).toBe(0);

    // The wallet (and later its ledger) still belongs to the same user id.
    expect(await prisma.wallet.findUnique({ where: { id: wallet.id } })).not.toBeNull();

    expect((await request(app).get('/api/v1/me').set(session.auth)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD })
      ).status,
    ).toBe(401);

    // The email address can be used for a new account.
    const again = await request(app).post('/api/v1/auth/register').send({
      email: user.email,
      password: TEST_PASSWORD,
      firstName: 'New',
      lastName: 'Start',
      preferredLanguage: 'en',
    });
    expect(again.status).toBe(201);
    expect(
      await prisma.auditLog.count({ where: { action: 'user.account_deleted', entityId: user.id } }),
    ).toBe(1);
  });

  it('is not available to admins', async () => {
    const admin = await createUser(prisma, { role: 'ADMIN' });
    const adminSession = await loginAs(app, admin);
    const res = await request(app)
      .delete('/api/v1/me')
      .set(adminSession.auth)
      .send({ password: TEST_PASSWORD });
    expect(res.status).toBe(403);
  });
});
