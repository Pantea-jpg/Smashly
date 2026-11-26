import { generateKeyPairSync, type KeyObject, verify } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApnsPushProvider } from './apns';

/** A local, unencrypted HTTP/2 server standing in for api.push.apple.com. */
interface Captured {
  headers: http2.IncomingHttpHeaders;
  body: string;
}
let server: http2.Http2Server;
let origin: string;
let publicKey: KeyObject;
let privateKeyPem: string;
const captured: Captured[] = [];
let reply: (headers: http2.IncomingHttpHeaders) => { status: number; body?: object } = () => ({
  status: 200,
});

beforeAll(async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  publicKey = keys.publicKey;
  privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      captured.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
      const { status, body } = reply(headers);
      stream.respond({ ':status': status, 'apns-id': 'apns-123' });
      stream.end(body ? JSON.stringify(body) : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured.length = 0;
  reply = () => ({ status: 200 });
});

const TOKEN = 'a'.repeat(64);

function provider(now = () => Date.now()) {
  return new ApnsPushProvider(
    {
      keyId: 'KEY1234567',
      teamId: 'TEAM123456',
      privateKeyPem,
      bundleId: 'com.trainingwallet.app',
      environment: 'sandbox',
      origin,
    },
    now,
  );
}

function decodeJwt(authorization: string | string[] | undefined) {
  const jwt = String(authorization).replace(/^bearer /, '');
  const [header, claims, signature] = jwt.split('.') as [string, string, string];
  return {
    jwt,
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>,
    valid: verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
  };
}

describe('ApnsPushProvider', () => {
  it('sends an alert with the APNs headers and an ES256 provider token', async () => {
    const apns = provider();
    const expiresAt = new Date('2026-12-01T18:00:00Z');
    const result = await apns.send({
      token: TOKEN,
      title: 'Training reminder',
      body: 'Tuesday · 19:00',
      badge: 3,
      threadId: 'REMINDERS',
      data: { notificationId: 'n1', trainingId: 't1' },
      expiresAt,
    });
    await apns.close();

    expect(result).toEqual({ ok: true, providerMessageId: 'apns-123' });
    const [request] = captured;
    expect(request?.headers).toMatchObject({
      ':method': 'POST',
      ':path': `/3/device/${TOKEN}`,
      'apns-topic': 'com.trainingwallet.app',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(expiresAt.getTime() / 1000),
    });
    expect(JSON.parse(request?.body ?? '{}')).toEqual({
      aps: {
        alert: { title: 'Training reminder', body: 'Tuesday · 19:00' },
        sound: 'default',
        badge: 3,
        'thread-id': 'REMINDERS',
      },
      notificationId: 'n1',
      trainingId: 't1',
    });
    const jwt = decodeJwt(request?.headers.authorization);
    expect(jwt.header).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(jwt.claims).toMatchObject({ iss: 'TEAM123456' });
    expect(jwt.valid).toBe(true);
  });

  it('reuses the provider token for 40 minutes, then signs a new one', async () => {
    let now = Date.parse('2026-11-25T10:00:00Z');
    const apns = provider(() => now);
    const first = apns.providerToken();
    now += 39 * 60_000;
    expect(apns.providerToken()).toBe(first);
    now += 2 * 60_000;
    expect(apns.providerToken()).not.toBe(first);
    await apns.close();
  });

  it.each([
    [410, 'Unregistered', true],
    [400, 'BadDeviceToken', true],
    [400, 'DeviceTokenNotForTopic', true],
    [400, 'PayloadTooLarge', false],
    [429, 'TooManyRequests', false],
    [503, 'ServiceUnavailable', false],
  ] as const)('HTTP %i %s → unregistered=%s', async (status, reason, unregistered) => {
    reply = () => ({ status, body: { reason } });
    const apns = provider();
    const result = await apns.send({ token: TOKEN, title: 't', body: 'b', data: {} });
    await apns.close();
    expect(result).toEqual({ ok: false, reason, unregistered });
  });

  it('signs a fresh provider token after ExpiredProviderToken', async () => {
    reply = () => ({ status: 403, body: { reason: 'ExpiredProviderToken' } });
    let now = Date.parse('2026-11-25T10:00:00Z');
    const apns = provider(() => now);
    await apns.send({ token: TOKEN, title: 't', body: 'b', data: {} });
    now += 1000; // a new iat makes the token visibly different
    reply = () => ({ status: 200 });
    await apns.send({ token: TOKEN, title: 't', body: 'b', data: {} });
    await apns.close();
    const [a, b] = captured.map((c) => decodeJwt(c.headers.authorization).jwt);
    expect(a).not.toBe(b);
  });

  it('reports a network failure as transient', async () => {
    const apns = new ApnsPushProvider({
      keyId: 'KEY1234567',
      teamId: 'TEAM123456',
      privateKeyPem,
      bundleId: 'com.trainingwallet.app',
      environment: 'sandbox',
      origin: 'http://127.0.0.1:1',
    });
    const result = await apns.send({ token: TOKEN, title: 't', body: 'b', data: {} });
    await apns.close();
    expect(result).toMatchObject({ ok: false, unregistered: false });
  });
});
