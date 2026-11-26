import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser } from '../../../test/fixtures';

const prisma = useTestDatabase();
const { app } = buildTestApp({ prisma });

type Operation = { security?: unknown[] };
const document = app.locals.openApiDocument() as unknown as {
  paths: Record<string, Record<string, Operation>>;
};

/** Every documented operation. Routes are registered through ApiRouter, so docs == routes. */
const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => ({
    method,
    path,
    url: path.replace(/\{[^}]+\}/g, '0192f6d2-7a3c-7b1e-9f00-1234567890ab'),
    secured: Array.isArray(op.security) && op.security.length > 0,
  })),
);
const adminOperations = operations.filter((op) => op.path.startsWith('/api/v1/admin'));
const securedOperations = operations.filter((op) => op.secured);

function call(method: string, url: string) {
  const agent = request(app);
  switch (method) {
    case 'get':
      return agent.get(url);
    case 'post':
      return agent.post(url).send({});
    case 'put':
      return agent.put(url).send({});
    case 'patch':
      return agent.patch(url).send({});
    case 'delete':
      return agent.delete(url);
    default:
      throw new Error(`unsupported method ${method}`);
  }
}

let userToken = '';
let adminToken = '';

beforeEach(async () => {
  const user = await createUser(prisma);
  const admin = await createUser(prisma, { role: 'ADMIN' });
  const login = async (email: string, password: string) =>
    (await request(app).post('/api/v1/auth/login').send({ email, password })).body.data.tokens
      .accessToken as string;
  userToken = await login(user.email, user.password);
  adminToken = await login(admin.email, admin.password);
});

describe('route inventory', () => {
  it('has admin routes to check', () => {
    expect(adminOperations.length).toBeGreaterThan(0);
  });

  it('documents every admin route as secured', () => {
    expect(adminOperations.filter((op) => !op.secured)).toEqual([]);
  });
});

describe.each(securedOperations)('$method $path', ({ method, url }) => {
  it('rejects requests without a token (401)', async () => {
    const res = await call(method, url);
    expect(res.status).toBe(401);
  });
});

describe.each(adminOperations)('admin $method $path', ({ method, url }) => {
  it('rejects a USER (403 FORBIDDEN)', async () => {
    const res = await call(method, url).set('authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets an ADMIN through', async () => {
    const res = await call(method, url).set('authorization', `Bearer ${adminToken}`);
    expect([401, 403]).not.toContain(res.status);
  });
});

describe('role changes apply immediately', () => {
  it('a demoted admin loses admin access with the same token', async () => {
    const admin = await createUser(prisma, { role: 'ADMIN' });
    const token = (
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: admin.password })
    ).body.data.tokens.accessToken as string;
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
    const res = await request(app)
      .get('/api/v1/admin/audit-logs')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/audit-logs', () => {
  it('pages through entries newest first with the cursor envelope', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit-logs?limit=1&action=auth.login')
      .set('authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.page).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });

    const next = await request(app)
      .get(
        `/api/v1/admin/audit-logs?limit=1&action=auth.login&cursor=${res.body.meta.page.nextCursor}`,
      )
      .set('authorization', `Bearer ${adminToken}`);
    expect(next.body.data).toHaveLength(1);
    expect(next.body.data[0].id).not.toBe(res.body.data[0].id);
    expect(next.body.data[0].id < res.body.data[0].id).toBe(true);
    expect(next.body.meta.page.hasMore).toBe(false);
  });

  it('rejects a tampered cursor', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit-logs?cursor=bm90LWEtdXVpZA')
      .set('authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
