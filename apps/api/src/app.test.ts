import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppOptions } from '../test/fixtures';

function buildApp(options: TestAppOptions = {}) {
  return buildTestApp(options).app;
}

describe('health', () => {
  it('GET /health/live is always ok', async () => {
    const res = await request(buildApp()).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', version: 'test' });
  });

  it('GET /health/ready is 200 when every dependency is healthy', async () => {
    const app = buildApp({ healthChecks: [{ name: 'database', check: () => Promise.resolve() }] });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: 'ok' });
  });

  it('GET /health/ready is 503 when a dependency fails', async () => {
    const app = buildApp({
      healthChecks: [
        { name: 'database', check: () => Promise.reject(new Error('connection refused')) },
        { name: 'cache', check: () => Promise.resolve() },
      ],
    });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'down', checks: { database: 'down', cache: 'ok' } });
  });
});

describe('error envelope', () => {
  it('returns NOT_FOUND with the request id for unknown routes', async () => {
    const res = await request(buildApp()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('maps malformed JSON to VALIDATION_ERROR', async () => {
    const res = await request(buildApp())
      .post('/api/v1/anything')
      .set('content-type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('maps oversized bodies to PAYLOAD_TOO_LARGE', async () => {
    const res = await request(buildApp())
      .post('/api/v1/anything')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('request id', () => {
  it('reuses a well-formed incoming X-Request-Id', async () => {
    const res = await request(buildApp()).get('/health/live').set('x-request-id', 'abc12345-trace');
    expect(res.headers['x-request-id']).toBe('abc12345-trace');
  });

  it('replaces a malformed incoming X-Request-Id', async () => {
    const res = await request(buildApp()).get('/health/live').set('x-request-id', 'bad id!');
    expect(res.headers['x-request-id']).not.toBe('bad id!');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('security headers', () => {
  it('sets helmet headers and hides x-powered-by', async () => {
    const res = await request(buildApp()).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('does not emit CORS headers when no origin is allowed', async () => {
    const res = await request(buildApp()).get('/health/live').set('origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows configured origins', async () => {
    const app = buildApp({ corsOrigins: ['https://admin.example'] });
    const res = await request(app).get('/health/live').set('origin', 'https://admin.example');
    expect(res.headers['access-control-allow-origin']).toBe('https://admin.example');
  });
});

describe('OpenAPI', () => {
  it('documents every auth, me and admin route with security where required', async () => {
    const res = await request(buildApp()).get('/api/docs/openapi.json');
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths as Record<string, unknown>);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/register',
        '/api/v1/auth/login',
        '/api/v1/auth/refresh',
        '/api/v1/auth/logout',
        '/api/v1/auth/password/forgot',
        '/api/v1/auth/password/reset',
        '/api/v1/auth/email/verify',
        '/api/v1/me',
        '/api/v1/admin/audit-logs',
      ]),
    );
    expect(res.body.paths['/api/v1/auth/login'].post.security).toBeUndefined();
    expect(res.body.paths['/api/v1/me'].get.security).toEqual([{ bearerAuth: [] }]);
  });

  it('serves Swagger UI with its own relaxed CSP, keeping the strict CSP on the API', async () => {
    const app = buildApp();
    const docs = await request(app).get('/api/docs/');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('swagger-ui');
    const api = await request(app).get('/health/live');
    expect(api.headers['content-security-policy']).toContain("default-src 'self'");
  });
});

describe('authentication guard (no database needed)', () => {
  it.each(['/api/v1/me', '/api/v1/admin/audit-logs'])(
    '%s requires a bearer token',
    async (path) => {
      const res = await request(buildApp()).get(path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    },
  );

  it('rejects malformed tokens', async () => {
    const res = await request(buildApp())
      .get('/api/v1/me')
      .set('authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
