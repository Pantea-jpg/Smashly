import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import http2, { type ClientHttp2Session } from 'node:http2';
import type { PushMessage, PushProvider, PushResult } from './push-provider';

export interface ApnsConfig {
  /** 10-character key id of the .p8 key (Apple Developer → Keys). */
  keyId: string;
  /** 10-character Apple Developer team id. */
  teamId: string;
  /** Contents of the .p8 file (PKCS#8 PEM, ES256). */
  privateKeyPem: string;
  /** The app's bundle identifier (the APNs topic). */
  bundleId: string;
  /**
   * Development builds get sandbox tokens; TestFlight and App Store builds get production
   * tokens. Sending a token to the wrong environment answers BadDeviceToken.
   */
  environment: 'sandbox' | 'production';
  /** Tests only: a local HTTP/2 server instead of Apple. */
  origin?: string;
  requestTimeoutMs?: number;
}

const ORIGINS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const;

/** Apple refuses provider tokens older than 1 hour and throttles refreshing more than every 20 min. */
const JWT_REFRESH_MS = 40 * 60_000;

/** Reasons meaning the token will never work again: stop using it. */
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/**
 * Direct APNs client: HTTP/2 with token-based (.p8) authentication, no third-party relay.
 * Keeps one connection open and reconnects when Apple closes it.
 */
export class ApnsPushProvider implements PushProvider {
  readonly name = 'apns';
  private readonly key: KeyObject;
  private readonly origin: string;
  private session: ClientHttp2Session | undefined;
  private jwt: { token: string; issuedAt: number } | undefined;

  constructor(
    private readonly config: ApnsConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createPrivateKey(config.privateKeyPem);
    this.origin = config.origin ?? ORIGINS[config.environment];
  }

  /** ES256 provider token, cached and refreshed every 40 minutes. */
  providerToken(): string {
    const nowMs = this.now();
    if (this.jwt && nowMs - this.jwt.issuedAt < JWT_REFRESH_MS) return this.jwt.token;
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: this.config.keyId }));
    const claims = b64url(
      JSON.stringify({ iss: this.config.teamId, iat: Math.floor(nowMs / 1000) }),
    );
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: this.key,
      dsaEncoding: 'ieee-p1363', // JOSE wants raw r||s, not DER
    });
    this.jwt = { token: `${header}.${claims}.${b64url(signature)}`, issuedAt: nowMs };
    return this.jwt.token;
  }

  private connect(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const session = http2.connect(this.origin);
    session.on('error', () => session.destroy());
    session.on('goaway', () => session.close());
    session.on('close', () => {
      if (this.session === session) this.session = undefined;
    });
    session.unref(); // never keeps the process alive on its own
    this.session = session;
    return session;
  }

  send(message: PushMessage): Promise<PushResult> {
    const body = JSON.stringify({
      aps: {
        alert: { title: message.title, body: message.body },
        sound: 'default',
        ...(message.badge !== undefined ? { badge: message.badge } : {}),
        ...(message.threadId ? { 'thread-id': message.threadId } : {}),
      },
      ...message.data,
    });
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${message.token}`,
      authorization: `bearer ${this.providerToken()}`,
      'apns-topic': this.config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      ...(message.expiresAt
        ? { 'apns-expiration': String(Math.floor(message.expiresAt.getTime() / 1000)) }
        : {}),
    };

    return new Promise<PushResult>((resolve) => {
      let session: ClientHttp2Session;
      try {
        session = this.connect();
      } catch (error) {
        resolve({ ok: false, reason: `connect: ${String(error)}`, unregistered: false });
        return;
      }
      const request = session.request(headers);
      request.setTimeout(this.config.requestTimeoutMs ?? 10_000, () => {
        request.close(http2.constants.NGHTTP2_CANCEL);
        resolve({ ok: false, reason: 'timeout', unregistered: false });
      });
      let status = 0;
      let apnsId: string | null = null;
      const chunks: Buffer[] = [];
      request.on('response', (responseHeaders) => {
        status = Number(responseHeaders[':status']);
        const id = responseHeaders['apns-id'];
        apnsId = typeof id === 'string' ? id : null;
      });
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('error', (error: Error) =>
        resolve({ ok: false, reason: `network: ${error.message}`, unregistered: false }),
      );
      request.on('end', () => {
        if (status === 200) {
          resolve({ ok: true, providerMessageId: apnsId });
          return;
        }
        let reason = `HTTP ${String(status)}`;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: string };
          if (parsed.reason) reason = parsed.reason;
        } catch {
          // empty or non-JSON body: keep the status
        }
        if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') {
          this.jwt = undefined; // next attempt signs a fresh token
        }
        resolve({
          ok: false,
          reason,
          unregistered: status === 410 || DEAD_TOKEN_REASONS.has(reason),
        });
      });
      request.end(body);
    });
  }

  close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (!session || session.closed) return Promise.resolve();
    return new Promise((resolve) => session.close(() => resolve()));
  }
}
