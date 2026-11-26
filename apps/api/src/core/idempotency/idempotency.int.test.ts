import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { createUser } from '../../../test/fixtures';
import { requestContext } from '../context/request-context';
import { errorHandler } from '../errors/error-handler';
import { requestLogging } from '../http/request-logging';
import { canonicalJson, idempotency } from './idempotency';

const prisma = useTestDatabase();

let actorId = '';
let calls = 0;
let releaseSlow: (() => void) | undefined;

/** A tiny app: fake authentication + the middleware + handlers with observable side effects. */
function testApp() {
  const app = express();
  app.use(requestLogging(pino({ level: 'silent' })));
  app.use(express.json());
  app.use(requestContext);
  app.use((req, _res, next) => {
    req.context.actor = { id: actorId, role: 'ADMIN' };
    next();
  });
  const guard = idempotency(prisma, { required: true });
  app.post('/payments', guard, (req, res) => {
    calls += 1;
    res
      .status(201)
      .json({ data: { call: calls, amount: (req.body as { amount: number }).amount } });
  });
  app.post('/boom', guard, () => {
    calls += 1;
    throw new Error('server failure');
  });
  app.post('/slow', guard, async (_req, res) => {
    calls += 1;
    await new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    res.status(201).json({ data: { ok: true } });
  });
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  actorId = (await createUser(prisma, { role: 'ADMIN' })).id;
  calls = 0;
});

describe('Idempotency-Key', () => {
  it('is required when configured', async () => {
    const res = await request(testApp()).post('/payments').send({ amount: 500 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('replays the stored response without running the handler again', async () => {
    const app = testApp();
    const first = await request(app)
      .post('/payments')
      .set('idempotency-key', 'key-000001')
      .send({ amount: 500 });
    const second = await request(app)
      .post('/payments')
      .set('idempotency-key', 'key-000001')
      .send({ amount: 500 });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(calls).toBe(1);
  });

  it('treats bodies with reordered keys as the same request', async () => {
    const app = testApp();
    await request(app)
      .post('/payments')
      .set('idempotency-key', 'key-000002')
      .send({ amount: 500, note: 'a' });
    const again = await request(app)
      .post('/payments')
      .set('idempotency-key', 'key-000002')
      .send({ note: 'a', amount: 500 });
    expect(again.status).toBe(201);
    expect(calls).toBe(1);
  });

  it('rejects reuse of a key for a different request', async () => {
    const app = testApp();
    await request(app).post('/payments').set('idempotency-key', 'key-000003').send({ amount: 500 });
    const res = await request(app)
      .post('/payments')
      .set('idempotency-key', 'key-000003')
      .send({ amount: 999 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(calls).toBe(1);
  });

  it('scopes keys per actor', async () => {
    const app = testApp();
    await request(app).post('/payments').set('idempotency-key', 'key-000004').send({ amount: 500 });
    actorId = (await createUser(prisma, { role: 'ADMIN' })).id;
    const other = await request(app)
      .post('/payments')
      .set('idempotency-key', 'key-000004')
      .send({ amount: 500 });
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('does not store 5xx responses, so the request can be retried', async () => {
    const app = testApp();
    const first = await request(app).post('/boom').set('idempotency-key', 'key-000005').send({});
    const second = await request(app).post('/boom').set('idempotency-key', 'key-000005').send({});
    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(calls).toBe(2);
  });

  it('reports a concurrent duplicate as in progress', async () => {
    const app = testApp();
    const slow = request(app)
      .post('/slow')
      .set('idempotency-key', 'key-000006')
      .send({})
      .then((r) => r);
    // Wait until the first request is inside the handler.
    while (!releaseSlow) await new Promise((r) => setTimeout(r, 10));
    const duplicate = await request(app)
      .post('/slow')
      .set('idempotency-key', 'key-000006')
      .send({});
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    releaseSlow();
    expect((await slow).status).toBe(201);
    expect(calls).toBe(1);
  });

  it('rejects malformed keys', async () => {
    const res = await request(testApp())
      .post('/payments')
      .set('idempotency-key', 'bad key!')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"x":2,"y":1}]},"b":1}',
    );
  });
});
