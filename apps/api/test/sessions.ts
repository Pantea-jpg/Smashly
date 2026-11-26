import request from 'supertest';
import type { App } from '../src/app';

export interface TestSession {
  accessToken: string;
  refreshToken: string;
  auth: { authorization: string };
}

/** Logs in through the real endpoint and returns ready-to-use headers. */
export async function loginAs(
  app: App,
  credentials: { email: string; password: string },
): Promise<TestSession> {
  const res = await request(app).post('/api/v1/auth/login').send(credentials);
  if (res.status !== 200) {
    throw new Error(`login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const tokens = res.body.data.tokens as { accessToken: string; refreshToken: string };
  return { ...tokens, auth: { authorization: `Bearer ${tokens.accessToken}` } };
}
