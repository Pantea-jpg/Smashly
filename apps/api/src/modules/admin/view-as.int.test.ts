import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser } from '../../../test/fixtures';
import { loginAs, type TestSession } from '../../../test/sessions';
import { VIEW_SESSION_TTL_MS } from './view-sessions.service';

const prisma = useTestDatabase();
let clock = Date.now();
const { app } = buildTestApp({ prisma, now: () => new Date(clock) });

const document = app.locals.openApiDocument() as unknown as {
  paths: Record<string, Record<string, unknown>>;
};
const FAKE_ID = '0192f6d2-7a3c-7b1e-9f00-1234567890ab';

/** Every documented non-GET operation, public ones included. */
const writeOperations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.keys(methods)
    .filter((method) => method !== 'get')
    .map((method) => ({ method, path, url: path.replace(/\{[^}]+\}/g, FAKE_ID) })),
);

let admin: TestSession;
let member: { id: string; email: string; password: string };
let viewSessionId: string;

async function startViewing(as: TestSession, userId: string) {
  return request(app).post('/api/v1/admin/view-sessions').set(as.auth).send({ userId });
}

beforeEach(async () => {
  clock = Date.now();
  const a = await createUser(prisma, { role: 'ADMIN' });
  admin = await loginAs(app, a);
  member = await createUser(prisma);
  await prisma.userProfile.update({ where: { userId: member.id }, data: { firstName: 'Anna' } });
  const res = await startViewing(admin, member.id);
  expect(res.status).toBe(201);
  viewSessionId = res.body.data.id as string;
});

describe('reading as the user', () => {
  it('GET /me and /me/profile return the viewed user while the admin stays the actor', async () => {
    const me = await request(app)
      .get('/api/v1/me')
      .set(admin.auth)
      .set('x-view-session', viewSessionId);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ id: member.id, firstName: 'Anna', role: 'USER' });

    const profile = await request(app)
      .get('/api/v1/me/profile')
      .set(admin.auth)
      .set('x-view-session', viewSessionId);
    expect(profile.body.data.id).toBe(member.id);

    // Without the header the admin sees themself.
    const self = await request(app).get('/api/v1/me').set(admin.auth);
    expect(self.body.data.role).toBe('ADMIN');
  });

  it('audits the session start and every read', async () => {
    await request(app).get('/api/v1/me').set(admin.auth).set('x-view-session', viewSessionId);
    await request(app)
      .get('/api/v1/me/profile')
      .set(admin.auth)
      .set('x-view-session', viewSessionId);
    const reads = await prisma.auditLog.findMany({ where: { action: 'view_session.read' } });
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ entityId: member.id, viewSessionId });
    expect(await prisma.auditLog.count({ where: { action: 'view_session.started' } })).toBe(1);
  });

  it('does not allow the data export', async () => {
    const res = await request(app)
      .get('/api/v1/me/export')
      .set(admin.auth)
      .set('x-view-session', viewSessionId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('VIEW_AS_READ_ONLY');
  });

  it('does not apply to admin endpoints', async () => {
    const res = await request(app)
      .get('/api/v1/admin/users')
      .set(admin.auth)
      .set('x-view-session', viewSessionId);
    expect(res.body.error.code).toBe('VIEW_AS_READ_ONLY');
  });
});

describe('read-only guarantee', () => {
  it('covers write operations', () => {
    expect(writeOperations.length).toBeGreaterThan(10);
  });

  it.each(writeOperations)(
    '$method $path is rejected with VIEW_AS_READ_ONLY',
    async ({ method, url }) => {
      const agent = request(app);
      const call =
        method === 'post'
          ? agent.post(url)
          : method === 'put'
            ? agent.put(url)
            : method === 'patch'
              ? agent.patch(url)
              : agent.delete(url);
      const res = await call
        .set(admin.auth)
        .set('x-view-session', viewSessionId)
        .send({ password: 'irrelevant', firstName: 'Hacked' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('VIEW_AS_READ_ONLY');
    },
  );

  it('left the viewed user untouched', async () => {
    await request(app)
      .patch('/api/v1/me/profile')
      .set(admin.auth)
      .set('x-view-session', viewSessionId)
      .send({ firstName: 'Hacked' });
    const profile = await prisma.userProfile.findUniqueOrThrow({ where: { userId: member.id } });
    expect(profile.firstName).toBe('Anna');
  });
});

describe('session validity', () => {
  it('only admins may use a view session', async () => {
    const memberSession = await loginAs(app, member);
    const res = await request(app)
      .get('/api/v1/me')
      .set(memberSession.auth)
      .set('x-view-session', viewSessionId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it("another admin cannot use someone else's session", async () => {
    const other = await loginAs(app, await createUser(prisma, { role: 'ADMIN' }));
    const res = await request(app)
      .get('/api/v1/me')
      .set(other.auth)
      .set('x-view-session', viewSessionId);
    expect(res.body.error.code).toBe('VIEW_SESSION_INVALID');
  });

  it('expires after 30 minutes', async () => {
    clock += VIEW_SESSION_TTL_MS + 1000;
    // A fresh access token, so only the view session is stale.
    const fresh = await loginAs(app, {
      email: (await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).email,
      password: 'correct horse battery staple',
    });
    const res = await request(app)
      .get('/api/v1/me')
      .set(fresh.auth)
      .set('x-view-session', viewSessionId);
    expect(res.body.error.code).toBe('VIEW_SESSION_INVALID');
  });

  it('ends on request (DELETE without the header) and cannot be used afterwards', async () => {
    await request(app)
      .delete(`/api/v1/admin/view-sessions/${viewSessionId}`)
      .set(admin.auth)
      .expect(204);
    const res = await request(app)
      .get('/api/v1/me')
      .set(admin.auth)
      .set('x-view-session', viewSessionId);
    expect(res.body.error.code).toBe('VIEW_SESSION_INVALID');
    expect(await prisma.auditLog.count({ where: { action: 'view_session.ended' } })).toBe(1);
  });

  it('starting a new session ends the previous one', async () => {
    const second = await createUser(prisma);
    const res = await startViewing(admin, second.id);
    expect(res.body.data.subject.id).toBe(second.id);
    const old = await request(app)
      .get('/api/v1/me')
      .set(admin.auth)
      .set('x-view-session', viewSessionId);
    expect(old.body.error.code).toBe('VIEW_SESSION_INVALID');
  });

  it('cannot target admins or unknown users, and rejects malformed ids', async () => {
    const otherAdmin = await createUser(prisma, { role: 'ADMIN' });
    expect((await startViewing(admin, otherAdmin.id)).status).toBe(403);
    expect((await startViewing(admin, FAKE_ID)).status).toBe(404);
    const bad = await request(app).get('/api/v1/me').set(admin.auth).set('x-view-session', 'nope');
    expect(bad.body.error.code).toBe('VIEW_SESSION_INVALID');
  });

  it('ends when the viewed user deletes their account', async () => {
    await prisma.wallet.updateMany({ where: { userId: member.id }, data: { balanceMinor: 0 } });
    const memberSession = await loginAs(app, member);
    await request(app)
      .delete('/api/v1/me')
      .set(memberSession.auth)
      .send({ password: member.password })
      .expect(204);
    const res = await request(app)
      .get('/api/v1/me')
      .set(admin.auth)
      .set('x-view-session', viewSessionId);
    expect(res.body.error.code).toBe('VIEW_SESSION_INVALID');
  });
});
