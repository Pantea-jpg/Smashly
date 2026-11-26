import type { AuthSession, Profile, SessionUser } from '@tw/contracts';

export interface MockRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface MockResponse {
  status: number;
  body?: unknown;
}

export type Route = (request: MockRequest) => MockResponse | Promise<MockResponse>;

/**
 * Replaces global fetch with a tiny router keyed by "METHOD /path" (path without /api/v1).
 * Unmatched requests fail the test loudly. Returns the list of received requests.
 */
export function mockApi(routes: Record<string, Route>): MockRequest[] {
  const received: MockRequest[] = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const path = url.pathname.replace(/^\/api\/v1/, '') + url.search;
    const method = (init?.method ?? 'GET').toUpperCase();
    const request: MockRequest = {
      method,
      path,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    received.push(request);
    const route = routes[`${method} ${url.pathname.replace(/^\/api\/v1/, '')}`];
    if (!route) throw new Error(`Unmocked request: ${method} ${path}`);
    const { status, body } = await route(request);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response;
  });
  return received;
}

export function apiError(status: number, code: string): MockResponse {
  return { status, body: { error: { code, message: code, requestId: 'test' } } };
}

export function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: '0192f6d2-7a3c-7b1e-9f00-1234567890ab',
    email: 'anna@example.test',
    role: 'USER',
    status: 'ACTIVE',
    emailVerified: true,
    firstName: 'Anna',
    lastName: 'de Vries',
    preferredLanguage: 'en',
    ...overrides,
  };
}

let tokenCounter = 0;
export function session(
  overrides: Partial<SessionUser> = {},
  accessTtlMs = 15 * 60_000,
): AuthSession {
  tokenCounter += 1;
  return {
    user: user(overrides),
    tokens: {
      accessToken: `access-${tokenCounter}`,
      accessTokenExpiresAt: new Date(Date.now() + accessTtlMs).toISOString(),
      refreshToken: `refresh-token-${tokenCounter}-xxxxxxxxxxxxxxxxxxxxxxxx`,
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    },
  };
}

export function ok(data: unknown, status = 200): MockResponse {
  return { status, body: { data, meta: { requestId: 'test' } } };
}

export function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: '0192f6d2-7a3c-7b1e-9f00-1234567890ab',
    email: 'anna@example.test',
    role: 'USER',
    status: 'ACTIVE',
    emailVerified: true,
    firstName: 'Anna',
    lastName: 'de Vries',
    phone: null,
    avatarUrl: null,
    preferredLanguage: 'en',
    createdAt: '2026-01-15T10:00:00.000Z',
    ...overrides,
  };
}
