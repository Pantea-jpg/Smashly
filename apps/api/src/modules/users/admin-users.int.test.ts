import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser, TEST_PASSWORD } from '../../../test/fixtures';
import { loginAs, type TestSession } from '../../../test/sessions';

const prisma = useTestDatabase();
const { app } = buildTestApp({ prisma });

let admin: TestSession;
let adminId: string;

async function named(
  firstName: string,
  lastName: string,
  email: string,
  status?: 'ACTIVE' | 'INACTIVE' | 'PENDING_APPROVAL',
) {
  const user = await createUser(prisma, { email, ...(status ? { status } : {}) });
  await prisma.userProfile.update({ where: { userId: user.id }, data: { firstName, lastName } });
  return user;
}

beforeEach(async () => {
  const a = await createUser(prisma, { role: 'ADMIN' });
  adminId = a.id;
  admin = await loginAs(app, a);
});

describe('GET /admin/users', () => {
  it('searches every word across email, first and last name (case-insensitive)', async () => {
    await named('Anna', 'de Vries', 'anna@example.test');
    await named('Annabel', 'Smit', 'bel@example.test');
    await named('Sem', 'Jansen', 'sem.vries@example.test');

    const both = await request(app).get('/api/v1/admin/users?q=anna').set(admin.auth);
    expect(both.body.data.map((u: { email: string }) => u.email).sort()).toEqual([
      'anna@example.test',
      'bel@example.test',
    ]);

    const precise = await request(app).get('/api/v1/admin/users?q=ANNA%20vries').set(admin.auth);
    expect(precise.body.data.map((u: { email: string }) => u.email)).toEqual(['anna@example.test']);

    const byEmail = await request(app).get('/api/v1/admin/users?q=sem.vries').set(admin.auth);
    expect(byEmail.body.data).toHaveLength(1);
  });

  it('filters by status and debt, lists USER accounts by default', async () => {
    await named('Active', 'One', 'a1@example.test');
    await named('Pending', 'One', 'p1@example.test', 'PENDING_APPROVAL');
    const debtor = await named('Debt', 'Or', 'debt@example.test');
    await prisma.wallet.updateMany({ where: { userId: debtor.id }, data: { debtMinor: 400 } });

    const pending = await request(app)
      .get('/api/v1/admin/users?status=PENDING_APPROVAL')
      .set(admin.auth);
    expect(pending.body.data.map((u: { email: string }) => u.email)).toEqual(['p1@example.test']);

    const withDebt = await request(app).get('/api/v1/admin/users?hasDebt=true').set(admin.auth);
    expect(withDebt.body.data).toHaveLength(1);
    expect(withDebt.body.data[0].debt).toEqual({ amountMinor: 400, currency: 'EUR' });

    const all = await request(app).get('/api/v1/admin/users').set(admin.auth);
    expect(all.body.data.every((u: { role: string }) => u.role === 'USER')).toBe(true);
    const admins = await request(app).get('/api/v1/admin/users?role=ADMIN').set(admin.auth);
    expect(admins.body.data).toHaveLength(1);
    expect(admins.body.data[0].balance).toBeNull(); // admins have no wallet
  });

  it('pages with totals and stable sorting, and rejects unknown sort fields', async () => {
    for (const [first, last] of [
      ['A', 'Zeta'],
      ['B', 'Alpha'],
      ['C', 'Mid'],
    ]) {
      await named(first!, last!, `${last!.toLowerCase()}@example.test`);
    }
    const page1 = await request(app)
      .get('/api/v1/admin/users?sort=lastName&pageSize=2')
      .set(admin.auth);
    expect(page1.body.meta.page).toEqual({ page: 1, pageSize: 2, total: 3 });
    expect(page1.body.data.map((u: { lastName: string }) => u.lastName)).toEqual(['Alpha', 'Mid']);

    const page2 = await request(app)
      .get('/api/v1/admin/users?sort=lastName&pageSize=2&page=2')
      .set(admin.auth);
    expect(page2.body.data.map((u: { lastName: string }) => u.lastName)).toEqual(['Zeta']);

    const bad = await request(app).get('/api/v1/admin/users?sort=passwordHash').set(admin.auth);
    expect(bad.status).toBe(400);
  });

  it('never exposes password hashes or tokens', async () => {
    await named('Anna', 'de Vries', 'anna@example.test');
    const res = await request(app).get('/api/v1/admin/users').set(admin.auth);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('argon2');
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('tokenVersion');
  });
});

describe('GET /admin/users/:id', () => {
  it('returns profile and wallet summary', async () => {
    const user = await named('Anna', 'de Vries', 'anna@example.test');
    await prisma.userProfile.update({
      where: { userId: user.id },
      data: { phone: '+31612345678' },
    });
    const res = await request(app).get(`/api/v1/admin/users/${user.id}`).set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      email: 'anna@example.test',
      phone: '+31612345678',
      preferredLanguage: 'en',
      balance: { amountMinor: 0, currency: 'EUR' },
      deletedAt: null,
    });
  });

  it('404s for unknown ids and 400s for malformed ones', async () => {
    expect(
      (
        await request(app)
          .get('/api/v1/admin/users/0192f6d2-7a3c-7b1e-9f00-000000000000')
          .set(admin.auth)
      ).status,
    ).toBe(404);
    expect((await request(app).get('/api/v1/admin/users/not-a-uuid').set(admin.auth)).status).toBe(
      400,
    );
  });
});

describe('PATCH /admin/users/:id/status', () => {
  it('deactivation signs the user out everywhere immediately and is audited', async () => {
    const user = await createUser(prisma);
    const session = await loginAs(app, user);

    const res = await request(app)
      .patch(`/api/v1/admin/users/${user.id}/status`)
      .set(admin.auth)
      .send({ status: 'INACTIVE', reason: 'Membership ended' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('INACTIVE');

    expect((await request(app).get('/api/v1/me').set(session.auth)).status).toBe(401);
    expect(
      (await request(app).post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken }))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD })
      ).body.error.code,
    ).toBe('ACCOUNT_INACTIVE');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.status_changed' },
    });
    expect(audit).toMatchObject({ actorId: adminId, entityId: user.id });
    expect(audit.after).toMatchObject({ status: 'INACTIVE', reason: 'Membership ended' });
  });

  it('approving a pending registration lets the user sign in and emails them', async () => {
    const user = await createUser(prisma, { status: 'PENDING_APPROVAL' });
    await request(app)
      .patch(`/api/v1/admin/users/${user.id}/status`)
      .set(admin.auth)
      .send({ status: 'ACTIVE', reason: 'Approved after intake' })
      .expect(200);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD })
      ).status,
    ).toBe(200);
    const email = await prisma.outboxEvent.findFirstOrThrow();
    expect(email.payload).toMatchObject({ template: 'accountApproved', to: user.email });
  });

  it('refuses to change your own status and requires a reason', async () => {
    const self = await request(app)
      .patch(`/api/v1/admin/users/${adminId}/status`)
      .set(admin.auth)
      .send({ status: 'INACTIVE', reason: 'oops' });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('CANNOT_MODIFY_OWN_ACCOUNT');

    const user = await createUser(prisma);
    const noReason = await request(app)
      .patch(`/api/v1/admin/users/${user.id}/status`)
      .set(admin.auth)
      .send({ status: 'INACTIVE' });
    expect(noReason.status).toBe(400);
  });

  it('is idempotent when the status does not change', async () => {
    const user = await createUser(prisma);
    await request(app)
      .patch(`/api/v1/admin/users/${user.id}/status`)
      .set(admin.auth)
      .send({ status: 'ACTIVE', reason: 'no-op' })
      .expect(200);
    expect(await prisma.auditLog.count({ where: { action: 'user.status_changed' } })).toBe(0);
  });
});

describe('admin settings', () => {
  it('reads and updates registration approval, with an audit entry', async () => {
    expect((await request(app).get('/api/v1/admin/settings').set(admin.auth)).body.data).toEqual({
      registrationRequiresApproval: false,
      topUpMinMinor: 500,
      topUpMaxMinor: 50_000,
      maxBalanceMinor: 100_000,
      topUpPresetsMinor: [1000, 2500, 5000, 10_000],
      lowBalanceThresholdMinor: 1000,
      reservationDebtBlockMinor: null,
      quietHours: { start: '22:00', end: '08:00' },
    });
    const res = await request(app)
      .patch('/api/v1/admin/settings')
      .set(admin.auth)
      .send({ registrationRequiresApproval: true });
    expect(res.body.data).toMatchObject({ registrationRequiresApproval: true });
    expect(await prisma.auditLog.count({ where: { action: 'settings.updated' } })).toBe(1);

    // New registrations now wait for approval.
    const reg = await request(app).post('/api/v1/auth/register').send({
      email: 'new@example.test',
      password: TEST_PASSWORD,
      firstName: 'New',
      lastName: 'Member',
      preferredLanguage: 'en',
    });
    expect(reg.body.data).toEqual({ status: 'PENDING_APPROVAL' });
  });
});
