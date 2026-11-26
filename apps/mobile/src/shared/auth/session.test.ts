import { SessionUserSchema } from '@tw/contracts';
import { apiError, mockApi, ok, session, user } from '../../../test/api';
import { isApiError } from '../api/http';
import { resetSessionStoreForTests, SessionController, useSessionStore } from './session';
import type { TokenStorage } from './tokenStorage';

function memoryStorage(initial: string | null = null): TokenStorage & { value: string | null } {
  const storage = {
    value: initial,
    getRefreshToken: () => Promise.resolve(storage.value),
    setRefreshToken: (token: string) => {
      storage.value = token;
      return Promise.resolve();
    },
    clear: () => {
      storage.value = null;
      return Promise.resolve();
    },
  };
  return storage;
}

function controller(storage: TokenStorage, now?: () => number) {
  return new SessionController({
    storage,
    getLanguage: () => 'nl',
    baseUrl: 'http://api.test',
    ...(now ? { now } : {}),
  });
}

beforeEach(() => {
  resetSessionStoreForTests();
});

describe('login', () => {
  it('keeps the access token in memory and the refresh token in secure storage', async () => {
    const storage = memoryStorage();
    const s = session();
    const requests = mockApi({ 'POST /auth/login': () => ok(s) });

    await controller(storage).login({ email: 'anna@example.test', password: 'x' });

    expect(storage.value).toBe(s.tokens.refreshToken);
    expect(useSessionStore.getState()).toMatchObject({
      status: 'signedIn',
      accessToken: s.tokens.accessToken,
      user: s.user,
    });
    expect(requests[0]?.headers['accept-language']).toBe('nl');
  });

  it('surfaces API error codes', async () => {
    mockApi({ 'POST /auth/login': () => apiError(401, 'INVALID_CREDENTIALS') });
    await expect(
      controller(memoryStorage()).login({ email: 'a@b.test', password: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    expect(useSessionStore.getState().status).toBe('restoring');
  });
});

describe('refresh', () => {
  it('is single-flight: concurrent expired requests share one refresh', async () => {
    const storage = memoryStorage();
    const first = session();
    const second = session();
    let refreshCalls = 0;
    mockApi({
      'POST /auth/login': () => ok(first),
      'POST /auth/refresh': async () => {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return ok(second);
      },
      'GET /me': (req) =>
        req.headers['authorization'] === `Bearer ${second.tokens.accessToken}`
          ? ok(user())
          : apiError(401, 'TOKEN_EXPIRED'),
    });
    const c = controller(storage);
    await c.login({ email: 'a@b.test', password: 'x' });

    const results = await Promise.all([
      c.request({ method: 'GET', path: '/me', schema: SessionUserSchema }),
      c.request({ method: 'GET', path: '/me', schema: SessionUserSchema }),
      c.request({ method: 'GET', path: '/me', schema: SessionUserSchema }),
    ]);

    expect(results).toHaveLength(3);
    expect(refreshCalls).toBe(1);
    expect(storage.value).toBe(second.tokens.refreshToken);
  });

  it('refreshes proactively when the access token is about to expire', async () => {
    const storage = memoryStorage();
    const soonExpired = session({}, 10_000);
    const fresh = session();
    const requests = mockApi({
      'POST /auth/login': () => ok(soonExpired),
      'POST /auth/refresh': () => ok(fresh),
      'GET /me': () => ok(user()),
    });
    const c = controller(storage);
    await c.login({ email: 'a@b.test', password: 'x' });
    await c.request({ method: 'GET', path: '/me', schema: SessionUserSchema });

    const me = requests.find((r) => r.path === '/me');
    expect(me?.headers['authorization']).toBe(`Bearer ${fresh.tokens.accessToken}`);
  });

  it('signs out locally when the server rejects the refresh token', async () => {
    const storage = memoryStorage();
    mockApi({
      'POST /auth/login': () => ok(session()),
      'POST /auth/refresh': () => apiError(401, 'UNAUTHENTICATED'),
      'GET /me': () => apiError(401, 'TOKEN_EXPIRED'),
    });
    const c = controller(storage);
    await c.login({ email: 'a@b.test', password: 'x' });

    const error: unknown = await c.request({ method: 'GET', path: '/me' }).catch((e: unknown) => e);
    expect(isApiError(error, 'UNAUTHENTICATED')).toBe(true);
    expect(useSessionStore.getState().status).toBe('signedOut');
    expect(storage.value).toBeNull();
  });
});

describe('restore', () => {
  it('signs out without a stored token', async () => {
    mockApi({});
    await controller(memoryStorage()).restore();
    expect(useSessionStore.getState().status).toBe('signedOut');
  });

  it('restores a session from the stored refresh token', async () => {
    const storage = memoryStorage('stored-refresh-token-xxxxxxxxxxxxxxxx');
    const s = session({ role: 'ADMIN' });
    mockApi({ 'POST /auth/refresh': () => ok(s) });
    await controller(storage).restore();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'signedIn',
      user: { role: 'ADMIN' },
    });
  });

  it('keeps the stored token when offline at launch', async () => {
    const storage = memoryStorage('stored-refresh-token-xxxxxxxxxxxxxxxx');
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    await controller(storage).restore();
    expect(useSessionStore.getState().status).toBe('signedOut');
    expect(storage.value).toBe('stored-refresh-token-xxxxxxxxxxxxxxxx');
  });
});

describe('logout', () => {
  it('clears the local session even if the server call fails', async () => {
    const storage = memoryStorage();
    mockApi({
      'POST /auth/login': () => ok(session()),
      'POST /auth/logout': () => apiError(500, 'INTERNAL_ERROR'),
    });
    const c = controller(storage);
    await c.login({ email: 'a@b.test', password: 'x' });
    await c.logout();
    expect(useSessionStore.getState().status).toBe('signedOut');
    expect(storage.value).toBeNull();
  });
});
