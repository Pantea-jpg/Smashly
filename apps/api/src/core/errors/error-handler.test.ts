import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseRequest, sendData } from '../http/respond';
import { requestLogging } from '../http/request-logging';
import { AppError } from './app-error';
import { errorHandler, notFoundHandler } from './error-handler';

function appWith(register: (app: express.Express) => void) {
  const app = express();
  app.use(requestLogging(pino({ level: 'silent' })));
  app.use(express.json());
  register(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('maps AppError to its status, code and details', async () => {
    const app = appWith((a) =>
      a.get('/full', () => {
        throw new AppError('TRAINING_FULL', 'Training is full', { capacity: 12 });
      }),
    );
    const res = await request(app).get('/full');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'TRAINING_FULL',
      message: 'Training is full',
      details: { capacity: 12 },
    });
  });

  it('hides internals of unexpected errors (sync and async)', async () => {
    const app = appWith((a) => {
      a.get('/sync', () => {
        throw new Error('secret database detail');
      });
      a.get('/async', async () => {
        await Promise.resolve();
        throw new Error('secret async detail');
      });
    });
    for (const path of ['/sync', '/async']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('secret');
    }
  });

  it('maps thrown ZodError to VALIDATION_ERROR', async () => {
    const app = appWith((a) =>
      a.get('/zod', () => {
        z.object({ a: z.string() }).parse({ a: 1 });
      }),
    );
    const res = await request(app).get('/zod');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('parseRequest', () => {
  const app = appWith((a) =>
    a.post('/items/:id', (req, res) => {
      const { body, params } = parseRequest(req, {
        body: z.object({ amountMinor: z.number().int().positive() }),
        params: z.object({ id: z.uuid() }),
      });
      sendData(req, res, { id: params.id, amountMinor: body.amountMinor }, 201);
    }),
  );
  const id = '0192f6d2-7a3c-7b1e-9f00-1234567890ab';

  it('returns typed values and strips unknown keys', async () => {
    const res = await request(app).post(`/items/${id}`).send({ amountMinor: 500, role: 'ADMIN' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id, amountMinor: 500 });
    expect(res.body.meta.requestId).toBeTruthy();
  });

  it('reports issues per request part', async () => {
    const res = await request(app).post('/items/not-a-uuid').send({ amountMinor: 12.5 });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toHaveProperty('body');
    expect(res.body.error.details).toHaveProperty('params');
  });
});
