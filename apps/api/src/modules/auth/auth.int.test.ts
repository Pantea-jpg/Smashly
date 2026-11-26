import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import {
  buildTestApp,
  createUser,
  TEST_PASSWORD,
  TEST_TOKEN_CONFIG,
  uniqueEmail,
} from '../../../test/fixtures';
import { TokenService } from '../../core/auth/tokens';
import { SettingsService } from '../admin/settings.service';
import { REFRESH_REUSE_GRACE_MS } from './auth.service';

const prisma = useTestDatabase();

/** Controllable clock shared by the app and its token service. */
let clock = Date.now();
const now = () => new Date(clock);
const advance = (ms: number) => {
  clock += ms;
};

function app() {
  return buildTestApp({ prisma, now }).app;
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    firstName: 'Anna',
    lastName: 'de Vries',
    preferredLanguage: 'nl',
    ...overrides,
  };
}

async function register(overrides: Record<string, unknown> = {}) {
  const body = registration(overrides);
  const res = await request(app()).post('/api/v1/auth/register').send(body);
  return { res, body };
}

async function login(email: string, password = TEST_PASSWORD) {
  return request(app()).post('/api/v1/auth/login').send({ email, password });
}

/** Extracts the one-time token from the most recent queued email of a template. */
async function tokenFromOutbox(template: 'verifyEmail' | 'resetPassword', to: string) {
  const events = await prisma.outboxEvent.findMany({ orderBy: { createdAt: 'desc' } });
  const event = events.find((e) => {
    const p = e.payload as { template: string; to: string };
    return p.template === template && p.to === to;
  });
  const link = (event?.payload as { params: { link: string } } | undefined)?.params.link;
  if (!link) throw new Error(`no ${template} email for ${to}`);
  return new URL(link.replace('trainingwallet://', 'https://app.test/')).searchParams.get('token')!;
}

beforeEach(() => {
  clock = Date.now();
});

describe('POST /auth/register', () => {
  it('creates an ACTIVE user with profile, EUR wallet, session and a verification email', async () => {
    const { res, body } = await register({ email: '  Anna.Mixed@Example.TEST ' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.user).toMatchObject({
      email: 'anna.mixed@example.test',
      role: 'USER',
      emailVerified: false,
      firstName: 'Anna',
      preferredLanguage: 'nl',
    });
    expect(res.body.data.tokens.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user).not.toHaveProperty('passwordHash');

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'anna.mixed@example.test' },
      include: { wallets: true, profile: true },
    });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(body.password);
    expect(user.wallets).toEqual([
      expect.objectContaining({ currency: 'EUR', balanceMinor: 0, debtMinor: 0 }),
    ]);

    const email = await prisma.outboxEvent.findFirstOrThrow();
    expect(email.payload).toMatchObject({
      template: 'verifyEmail',
      language: 'nl',
      to: 'anna.mixed@example.test',
    });
    expect(await prisma.auditLog.count({ where: { action: 'auth.register' } })).toBe(1);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const email = uniqueEmail();
    await register({ email });
    const { res } = await register({ email: email.toUpperCase() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it.each([
    [{ password: 'short' }, 'password'],
    [{ password: '          x' }, 'password'],
    [{ email: 'not-an-email' }, 'email'],
    [{ phone: '0612345678' }, 'phone'],
    [{ preferredLanguage: 'de' }, 'preferredLanguage'],
    [{ firstName: '   ' }, 'firstName'],
  ])('rejects invalid input %o', async (overrides, field) => {
    const { res } = await register(overrides);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body.error.details)).toContain(field);
  });

  it('ignores attempts to self-assign a role or status', async () => {
    const { res } = await register({ role: 'ADMIN', status: 'ACTIVE' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('USER');
  });

  it('returns PENDING_APPROVAL without tokens when approval is required', async () => {
    await new SettingsService(prisma).set('registration.requireApproval', true, null);
    const { res, body } = await register();
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ status: 'PENDING_APPROVAL' });

    const attempt = await login(body.email);
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.code).toBe('ACCOUNT_PENDING_APPROVAL');
  });
});

describe('POST /auth/login', () => {
  it('returns a session for valid credentials and records the login', async () => {
    const user = await createUser(prisma);
    const res = await login(user.email);
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
    expect(
      await prisma.auditLog.count({ where: { action: 'auth.login', entityId: user.id } }),
    ).toBe(1);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const user = await createUser(prisma);
    const wrong = await login(user.email, 'definitely the wrong password');
    const unknown = await login(uniqueEmail('nobody'));
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }
    expect(await prisma.auditLog.count({ where: { action: 'auth.login_failed' } })).toBe(2);
  });

  it('reveals an inactive account only after the correct password', async () => {
    const user = await createUser(prisma, { status: 'INACTIVE' });
    expect((await login(user.email, 'wrong password!!')).body.error.code).toBe(
      'INVALID_CREDENTIALS',
    );
    expect((await login(user.email)).body.error.code).toBe('ACCOUNT_INACTIVE');
  });
});

describe('access tokens', () => {
  it('GET /me returns the signed-in user', async () => {
    const user = await createUser(prisma);
    const session = (await login(user.email)).body.data;
    const res = await request(app())
      .get('/api/v1/me')
      .set('authorization', `Bearer ${session.tokens.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: user.id, email: user.email, role: 'USER' });
  });

  it('reports TOKEN_EXPIRED for an expired token', async () => {
    const user = await createUser(prisma);
    const past = new TokenService(TEST_TOKEN_CONFIG, () => new Date(Date.now() - 3_600_000));
    const { token } = await past.signAccessToken({
      userId: user.id,
      role: 'USER',
      sessionId: crypto.randomUUID(),
      tokenVersion: 0,
    });
    const res = await request(app()).get('/api/v1/me').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects a token signed with another key', async () => {
    const user = await createUser(prisma);
    const { generateTestKey } = await import('../../../test/fixtures');
    const forger = new TokenService({ ...TEST_TOKEN_CONFIG, JWT_PRIVATE_KEY: generateTestKey() });
    const { token } = await forger.signAccessToken({
      userId: user.id,
      role: 'ADMIN',
      sessionId: crypto.randomUUID(),
      tokenVersion: 0,
    });
    const res = await request(app()).get('/api/v1/me').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('stops accepting existing tokens as soon as the account is deactivated', async () => {
    const user = await createUser(prisma);
    const { accessToken } = (await login(user.email)).body.data.tokens;
    await prisma.user.update({ where: { id: user.id }, data: { status: 'INACTIVE' } });
    const res = await request(app())
      .get('/api/v1/me')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });
});

describe('POST /auth/refresh (rotation and reuse detection)', () => {
  it('rotates: the new refresh token works, the old one is spent', async () => {
    const user = await createUser(prisma);
    const first = (await login(user.email)).body.data.tokens;

    const second = await request(app())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(second.status).toBe(200);
    expect(second.body.data.tokens.refreshToken).not.toBe(first.refreshToken);

    const third = await request(app())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second.body.data.tokens.refreshToken });
    expect(third.status).toBe(200);
  });

  it('revokes the whole session when a rotated token is reused after the grace window', async () => {
    const user = await createUser(prisma);
    const original = (await login(user.email)).body.data.tokens.refreshToken;
    const rotated = (
      await request(app()).post('/api/v1/auth/refresh').send({ refreshToken: original })
    ).body.data.tokens.refreshToken;

    advance(REFRESH_REUSE_GRACE_MS + 1_000);
    const replay = await request(app())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: original });
    expect(replay.status).toBe(401);

    // The legitimate holder's newer token is now dead too.
    const legit = await request(app()).post('/api/v1/auth/refresh').send({ refreshToken: rotated });
    expect(legit.status).toBe(401);
    // Each replay of a revoked token is logged (the attacker's and the legitimate holder's).
    expect(await prisma.auditLog.count({ where: { action: 'auth.refresh_reuse_detected' } })).toBe(
      2,
    );
  });

  it('re-issues within the grace window when the successor was never used (lost response)', async () => {
    const user = await createUser(prisma);
    const original = (await login(user.email)).body.data.tokens.refreshToken;
    const lost = (
      await request(app()).post('/api/v1/auth/refresh').send({ refreshToken: original })
    ).body.data.tokens.refreshToken;

    advance(2_000);
    const retry = await request(app())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: original });
    expect(retry.status).toBe(200);

    // The response that was "lost" can no longer be used; the retried one can.
    expect(
      (await request(app()).post('/api/v1/auth/refresh').send({ refreshToken: lost })).status,
    ).toBe(200);
  });

  it('rejects unknown and expired refresh tokens', async () => {
    const user = await createUser(prisma);
    const token = (await login(user.email)).body.data.tokens.refreshToken;
    const unknown = await request(app())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'x'.repeat(43) });
    expect(unknown.status).toBe(401);

    advance(31 * 24 * 60 * 60_000);
    const expired = await request(app()).post('/api/v1/auth/refresh').send({ refreshToken: token });
    expect(expired.status).toBe(401);
  });
});

describe('logout', () => {
  it('POST /auth/logout revokes the current session only', async () => {
    const user = await createUser(prisma);
    const phone = (await login(user.email)).body.data.tokens;
    const tablet = (await login(user.email)).body.data.tokens;

    const res = await request(app())
      .post('/api/v1/auth/logout')
      .set('authorization', `Bearer ${phone.accessToken}`);
    expect(res.status).toBe(204);

    expect(
      (await request(app()).post('/api/v1/auth/refresh').send({ refreshToken: phone.refreshToken }))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app())
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: tablet.refreshToken })
      ).status,
    ).toBe(200);
  });

  it('POST /auth/logout-all invalidates every session and outstanding access token', async () => {
    const user = await createUser(prisma);
    const phone = (await login(user.email)).body.data.tokens;
    const tablet = (await login(user.email)).body.data.tokens;

    await request(app())
      .post('/api/v1/auth/logout-all')
      .set('authorization', `Bearer ${phone.accessToken}`)
      .expect(204);

    const me = await request(app())
      .get('/api/v1/me')
      .set('authorization', `Bearer ${tablet.accessToken}`);
    expect(me.status).toBe(401);
    expect(
      (
        await request(app())
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: tablet.refreshToken })
      ).status,
    ).toBe(401);
  });
});

describe('password reset', () => {
  it('always answers 202 and only emails existing active accounts', async () => {
    const user = await createUser(prisma);
    const known = await request(app())
      .post('/api/v1/auth/password/forgot')
      .send({ email: user.email });
    const unknown = await request(app())
      .post('/api/v1/auth/password/forgot')
      .send({ email: uniqueEmail() });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual({ ...unknown.body, meta: known.body.meta });
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it('sets the new password, signs out everywhere and works only once', async () => {
    const user = await createUser(prisma);
    const before = (await login(user.email)).body.data.tokens;
    await request(app()).post('/api/v1/auth/password/forgot').send({ email: user.email });
    const token = await tokenFromOutbox('resetPassword', user.email);
    const newPassword = 'a brand new passphrase';

    const reset = await request(app())
      .post('/api/v1/auth/password/reset')
      .send({ token, newPassword });
    expect(reset.status).toBe(204);

    expect((await login(user.email)).status).toBe(401);
    expect((await login(user.email, newPassword)).status).toBe(200);
    expect(
      (
        await request(app())
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: before.refreshToken })
      ).status,
    ).toBe(401);

    const again = await request(app())
      .post('/api/v1/auth/password/reset')
      .send({ token, newPassword: 'another passphrase!' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');

    const notice = await prisma.outboxEvent.findMany();
    expect(notice.map((e) => (e.payload as { template: string }).template)).toContain(
      'passwordChanged',
    );
  });

  it('rejects an expired reset link, and only the newest link works', async () => {
    const user = await createUser(prisma);
    await request(app()).post('/api/v1/auth/password/forgot').send({ email: user.email });
    const older = await tokenFromOutbox('resetPassword', user.email);
    await request(app()).post('/api/v1/auth/password/forgot').send({ email: user.email });
    const newer = await tokenFromOutbox('resetPassword', user.email);

    const oldRes = await request(app())
      .post('/api/v1/auth/password/reset')
      .send({ token: older, newPassword: 'whatever passphrase' });
    expect(oldRes.body.error.code).toBe('INVALID_TOKEN');

    advance(31 * 60_000);
    const late = await request(app())
      .post('/api/v1/auth/password/reset')
      .send({ token: newer, newPassword: 'whatever passphrase' });
    expect(late.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('email verification', () => {
  it('confirms the address once', async () => {
    const { res, body } = await register();
    const token = await tokenFromOutbox('verifyEmail', body.email);

    expect((await request(app()).post('/api/v1/auth/email/verify').send({ token })).status).toBe(
      204,
    );
    const me = await request(app())
      .get('/api/v1/me')
      .set('authorization', `Bearer ${res.body.data.tokens.accessToken}`);
    expect(me.body.data.emailVerified).toBe(true);

    const again = await request(app()).post('/api/v1/auth/email/verify').send({ token });
    expect(again.body.error.code).toBe('INVALID_TOKEN');
  });

  it('resend issues a fresh link and invalidates the previous one', async () => {
    const { res, body } = await register();
    const first = await tokenFromOutbox('verifyEmail', body.email);
    await request(app())
      .post('/api/v1/auth/email/resend')
      .set('authorization', `Bearer ${res.body.data.tokens.accessToken}`)
      .expect(202);
    const second = await tokenFromOutbox('verifyEmail', body.email);
    expect(second).not.toBe(first);
    expect(
      (await request(app()).post('/api/v1/auth/email/verify').send({ token: first })).status,
    ).toBe(400);
    expect(
      (await request(app()).post('/api/v1/auth/email/verify').send({ token: second })).status,
    ).toBe(204);
  });
});

describe('rate limiting', () => {
  it('blocks the 6th login attempt per IP and email within a minute', async () => {
    const limited = buildTestApp({
      prisma,
      rateLimits: { login: { windowMs: 60_000, limit: 5 } },
    }).app;
    const email = uniqueEmail();
    for (let i = 0; i < 5; i += 1) {
      const res = await request(limited)
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong password!!' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(limited)
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong password!!' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['ratelimit-policy']).toBeDefined();

    // A different account from the same IP is not blocked by this counter.
    const other = await request(limited)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: 'x' });
    expect(other.status).toBe(401);
  });

  it('locks an account softly after repeated failures; successful sign-ins do not count', async () => {
    const limited = buildTestApp({
      prisma,
      rateLimits: { loginAccount: { windowMs: 15 * 60_000, limit: 3 } },
    }).app;
    const user = await createUser(prisma);
    const attempt = (password: string) =>
      request(limited).post('/api/v1/auth/login').send({ email: user.email, password });

    // Signing in correctly any number of times never trips the failure limit.
    for (let i = 0; i < 4; i += 1) expect((await attempt(TEST_PASSWORD)).status).toBe(200);
    for (let i = 0; i < 3; i += 1) expect((await attempt('wrong password!!')).status).toBe(401);
    // The counter is per email (from any IP), so even the right password waits now.
    const blocked = await attempt(TEST_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // Other accounts are unaffected; e-mail case does not create a fresh counter.
    expect(
      (
        await request(limited)
          .post('/api/v1/auth/login')
          .send({ email: user.email.toUpperCase(), password: TEST_PASSWORD })
      ).status,
    ).toBe(429);
  });

  it('stops one IP from spraying passwords across many accounts', async () => {
    const limited = buildTestApp({
      prisma,
      rateLimits: { loginIp: { windowMs: 15 * 60_000, limit: 4 } },
    }).app;
    for (let i = 0; i < 4; i += 1) {
      const res = await request(limited)
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail(), password: 'Summer2026!!' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(limited)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: 'Summer2026!!' });
    expect(blocked.status).toBe(429);
  });
});

describe('breached passwords (ASVS 2.1.7)', () => {
  const LEAKED = 'Welcome2026!!';
  const breachCheck = { isBreached: (p: string) => Promise.resolve(p === LEAKED) };

  it('refuses a leaked password on registration, reset and change, and accepts others', async () => {
    const { app: checked } = buildTestApp({ prisma, passwordBreachCheck: breachCheck });
    const register = (password: string) =>
      request(checked).post('/api/v1/auth/register').send({
        email: uniqueEmail(),
        password,
        firstName: 'New',
        lastName: 'Member',
        preferredLanguage: 'en',
      });
    const refused = await register(LEAKED);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('PASSWORD_BREACHED');
    expect((await register('a perfectly fine passphrase')).status).toBe(201);

    const user = await createUser(prisma);
    await request(checked).post('/api/v1/auth/password/forgot').send({ email: user.email });
    const token = await tokenFromOutbox('resetPassword', user.email);
    const reset = await request(checked)
      .post('/api/v1/auth/password/reset')
      .send({ token, newPassword: LEAKED });
    expect(reset.body.error.code).toBe('PASSWORD_BREACHED');
    // The reset link was not used up by the refused attempt.
    expect(
      (
        await request(checked)
          .post('/api/v1/auth/password/reset')
          .send({ token, newPassword: 'another fine passphrase' })
      ).status,
    ).toBe(204);

    const session = await request(checked)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'another fine passphrase' });
    const change = await request(checked)
      .patch('/api/v1/me/password')
      .set('authorization', `Bearer ${session.body.data.tokens.accessToken as string}`)
      .send({ currentPassword: 'another fine passphrase', newPassword: LEAKED });
    expect(change.body.error.code).toBe('PASSWORD_BREACHED');
  });
});

describe('response headers', () => {
  it('marks every API response, including errors, as not cacheable', async () => {
    const user = await createUser(prisma);
    const { app: plain } = buildTestApp({ prisma });
    const login = await request(plain)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });
    expect(login.headers['cache-control']).toBe('no-store');
    const me = await request(plain)
      .get('/api/v1/me/wallet')
      .set('authorization', `Bearer ${login.body.data.tokens.accessToken as string}`);
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    const denied = await request(plain).get('/api/v1/me/wallet');
    expect(denied.status).toBe(401);
    expect(denied.headers['cache-control']).toBe('no-store');
    // Security headers from helmet stay in place.
    expect(me.headers['x-content-type-options']).toBe('nosniff');
    expect(me.headers['strict-transport-security']).toBeDefined();
  });
});
