/**
 * Phase 9 auth fuzzing: random and adversarial input against authentication. The properties:
 * nothing forged or malformed is ever accepted, and nothing crashes the server (no 5xx).
 */
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto';
import fc from 'fast-check';
import { SignJWT } from 'jose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser, TEST_TOKEN_CONFIG } from '../../../test/fixtures';
import { loginAs, type TestSession } from '../../../test/sessions';

const prisma = useTestDatabase();
const { app } = buildTestApp({ prisma });

const realKey = createPrivateKey(
  Buffer.from(TEST_TOKEN_CONFIG.JWT_PRIVATE_KEY, 'base64').toString('utf8'),
);
const publicPem = createPublicKey(realKey).export({ type: 'spki', format: 'pem' }).toString();
const otherKey = generateKeyPairSync('ed25519').privateKey;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

let user: { id: string; email: string; password: string };
let session: TestSession;

beforeEach(async () => {
  user = await createUser(prisma);
  session = await loginAs(app, user);
});

const AUTH_ERRORS = ['UNAUTHENTICATED', 'TOKEN_EXPIRED'];

async function getMe(authorization: string) {
  return request(app).get('/api/v1/me').set('authorization', authorization);
}

function expectRejected(res: request.Response) {
  expect(res.status).toBe(401);
  expect(AUTH_ERRORS).toContain(res.body.error.code);
}

/** A token signed with `key`, defaulting every claim to a valid one for `user`. */
async function craft(over: {
  key?: typeof realKey;
  kid?: string;
  typ?: string;
  claims?: Record<string, unknown>;
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: 'USER', sid: randomUUID(), tv: 0, ...over.claims })
    .setProtectedHeader({
      alg: 'EdDSA',
      kid: over.kid ?? TEST_TOKEN_CONFIG.JWT_KEY_ID,
      typ: over.typ ?? 'at+jwt',
    })
    .setSubject(over.sub ?? user.id)
    .setIssuer(over.iss ?? TEST_TOKEN_CONFIG.JWT_ISSUER)
    .setAudience(over.aud ?? TEST_TOKEN_CONFIG.JWT_AUDIENCE)
    .setIssuedAt(now - 10)
    .setExpirationTime(over.exp ?? now + 600)
    .sign(over.key ?? realKey);
}

describe('access tokens', () => {
  it('rejects arbitrary Authorization headers', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.stringMatching(/^[\x20-\x7e]{0,300}$/),
          fc.stringMatching(/^[A-Za-z0-9._~+/=-]{1,400}$/).map((t) => `Bearer ${t}`),
          fc
            .tuple(...[0, 1, 2].map(() => fc.stringMatching(/^[A-Za-z0-9_-]{0,120}$/)))
            .map((parts) => `Bearer ${parts.join('.')}`),
        ),
        async (header) => expectRejected(await getMe(header)),
      ),
      { numRuns: 200 },
    );
  });

  it('rejects any single-character change to a valid token', async () => {
    const token = session.accessToken;
    expect((await getMe(`Bearer ${token}`)).status).toBe(200);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    await fc.assert(
      fc.asyncProperty(
        // The last character is skipped: its low bits are padding, so some substitutions
        // decode to the same signature bytes (not a forgery).
        fc.integer({ min: 0, max: token.length - 2 }),
        fc.constantFrom(...alphabet),
        async (index, ch) => {
          fc.pre(token[index] !== ch && token[index] !== '.');
          const mutated = token.slice(0, index) + ch + token.slice(index + 1);
          expectRejected(await getMe(`Bearer ${mutated}`));
        },
      ),
      { numRuns: 150 },
    );
  });

  it('rejects forged tokens: alg none, HMAC with the public key, foreign key, wrong claims', async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: user.id,
      role: 'ADMIN',
      sid: randomUUID(),
      tv: 0,
      iss: TEST_TOKEN_CONFIG.JWT_ISSUER,
      aud: TEST_TOKEN_CONFIG.JWT_AUDIENCE,
      iat: now,
      exp: now + 600,
    };
    const hsInput = `${b64({ alg: 'HS256', kid: TEST_TOKEN_CONFIG.JWT_KEY_ID, typ: 'at+jwt' })}.${b64(payload)}`;
    const forged = [
      `${b64({ alg: 'none', typ: 'at+jwt' })}.${b64(payload)}.`,
      `${b64({ alg: 'none', kid: TEST_TOKEN_CONFIG.JWT_KEY_ID })}.${b64(payload)}.`,
      // Algorithm confusion: HS256 keyed with the public key's PEM text.
      `${hsInput}.${createHmac('sha256', publicPem).update(hsInput).digest('base64url')}`,
      await craft({ key: otherKey }), // right kid, wrong key
      await craft({ kid: 'unknown-kid' }),
      await craft({ typ: 'JWT' }), // an ID token or other JWT is not an access token
      await craft({ iss: 'someone-else' }),
      await craft({ aud: 'another-app' }),
      await craft({ exp: now - 1 }),
      await craft({ claims: { role: 'SUPERADMIN' } }),
      await craft({ claims: { tv: '0' } }),
      await craft({ claims: { sid: 42 } }),
      await craft({ claims: { tv: 7 } }), // stale token version ("signed out everywhere")
      await craft({ sub: randomUUID() }), // no such user
    ];
    for (const token of forged) expectRejected(await getMe(`Bearer ${token}`));
  });

  it('a token claiming ADMIN for a member does not open admin routes (the database role wins)', async () => {
    const token = await craft({ claims: { role: 'ADMIN' } });
    expect((await getMe(`Bearer ${token}`)).status).toBe(200);
    const res = await request(app)
      .get('/api/v1/admin/users')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('answers 401, not a server error, for a correctly signed token with a malformed subject', async () => {
    for (const sub of ['not-a-uuid', '', "' OR 1=1 --", 'x'.repeat(5000)]) {
      expectRejected(await getMe(`Bearer ${await craft({ sub })}`));
    }
  });
});

describe('public auth endpoints', () => {
  const endpoints = [
    '/api/v1/auth/login',
    '/api/v1/auth/register',
    '/api/v1/auth/refresh',
    '/api/v1/auth/password/forgot',
    '/api/v1/auth/password/reset',
    '/api/v1/auth/email/verify',
  ];

  it('never succeed or crash on arbitrary JSON bodies', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...endpoints), fc.jsonValue(), async (path, body) => {
        const res = await request(app)
          .post(path)
          .set('content-type', 'application/json')
          .send(JSON.stringify(body));
        // forgot-password always answers 202 by design (no account enumeration).
        if (path.endsWith('/forgot') && res.status === 202) return;
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.body.error.code).toEqual(expect.any(String));
      }),
      { numRuns: 200 },
    );
  });

  it('reject random refresh, reset and verification tokens', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          '/api/v1/auth/refresh',
          '/api/v1/auth/password/reset',
          '/api/v1/auth/email/verify',
        ),
        fc.stringMatching(/^[A-Za-z0-9_-]{20,120}$/),
        async (path, token) => {
          const res = await request(app)
            .post(path)
            .send({ refreshToken: token, token, newPassword: 'a perfectly fine password' });
          expect(res.status).toBeGreaterThanOrEqual(400);
          expect(res.status).toBeLessThan(500);
        },
      ),
      { numRuns: 120 },
    );
  });

  it('never signs in with a wrong password, whatever it looks like', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 128 }), async (password) => {
        fc.pre(password !== user.password);
        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: user.email, password });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      }),
      { numRuns: 40 }, // each attempt runs Argon2id
    );
  });

  it('ignores __proto__ and role fields on registration', async () => {
    const email = `proto.${Date.now()}@example.test`;
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('content-type', 'application/json')
      .send(
        `{"email":"${email}","password":"a perfectly fine password","firstName":"P","lastName":"Q",` +
          `"preferredLanguage":"en","role":"ADMIN","status":"ACTIVE","__proto__":{"role":"ADMIN"}}`,
      );
    expect(res.status).toBe(201);
    const created = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(created.role).toBe('USER');
    expect(({} as Record<string, unknown>)['role']).toBeUndefined();
  });

  it('rejects oversized bodies before parsing them', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
  });
});
