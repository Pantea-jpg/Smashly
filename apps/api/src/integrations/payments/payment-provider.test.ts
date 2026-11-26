import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StripePaymentProvider } from './payment-provider';

/**
 * The real Stripe SDK talking to a local HTTP server that stands in for api.stripe.com
 * (the same mechanism as STRIPE_API_URL / stripe-mock). Checks what we send and how we map
 * Stripe's answers, without network access or a Stripe account.
 */
interface Captured {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  form: URLSearchParams;
}
let server: http.Server;
let apiUrl: string;
const captured: Captured[] = [];
let reply: (req: Captured) => { status: number; body: object } = () => ({ status: 200, body: {} });

const intent = (over: Record<string, unknown> = {}) => ({
  id: 'pi_123',
  object: 'payment_intent',
  amount: 2500,
  amount_received: 0,
  currency: 'eur',
  status: 'requires_payment_method',
  client_secret: 'pi_123_secret_abc',
  payment_method_types: ['card', 'ideal'],
  last_payment_error: null,
  metadata: {},
  ...over,
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const c: Captured = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
      };
      captured.push(c);
      const { status, body } = reply(c);
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_test' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  captured.length = 0;
});

const provider = () =>
  new StripePaymentProvider({
    secretKey: 'sk_test_local',
    publishableKey: 'pk_test_local',
    webhookSecret: 'whsec_local',
    apiUrl,
  });

describe('StripePaymentProvider', () => {
  it('creates a top-up intent with automatic methods, metadata and the idempotency key', async () => {
    reply = () => ({ status: 200, body: intent() });
    const result = await provider().createTopUpIntent({
      amountMinor: 2500,
      currency: 'EUR',
      paymentId: 'pay-1',
      userId: 'user-1',
      idempotencyKey: 'topup:user-1:k1',
    });
    const req = captured[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/payment_intents');
    expect(req.headers.authorization).toBe('Bearer sk_test_local');
    expect(req.headers['idempotency-key']).toBe('topup:user-1:k1');
    expect(Object.fromEntries(req.form)).toMatchObject({
      amount: '2500',
      currency: 'eur',
      'automatic_payment_methods[enabled]': 'true',
      'metadata[paymentId]': 'pay-1',
      'metadata[userId]': 'user-1',
      'metadata[purpose]': 'wallet_top_up',
    });
    expect(result).toEqual({
      id: 'pi_123',
      clientSecret: 'pi_123_secret_abc',
      status: 'requires_payment_method',
      amountMinor: 2500,
      amountReceivedMinor: 0,
      currency: 'EUR',
      paymentMethodType: null, // two allowed types: unknown until paid
      lastErrorCode: null,
    });
  });

  it('retrieves and cancels intents, mapping the method and the last error', async () => {
    reply = (req) =>
      req.method === 'GET'
        ? {
            status: 200,
            body: intent({
              status: 'requires_payment_method',
              payment_method_types: ['ideal'],
              last_payment_error: { code: 'payment_intent_authentication_failure' },
            }),
          }
        : { status: 200, body: intent({ status: 'canceled' }) };
    const p = provider();
    expect(await p.retrieveIntent('pi_123')).toMatchObject({
      paymentMethodType: 'ideal',
      lastErrorCode: 'payment_intent_authentication_failure',
    });
    await p.cancelIntent('pi_123');
    expect(captured.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/payment_intents/pi_123',
      'POST /v1/payment_intents/pi_123/cancel',
    ]);
  });

  it('creates refunds idempotently and maps every shape of payment_intent and status', async () => {
    const p = provider();
    reply = () => ({
      status: 200,
      body: {
        id: 're_1',
        object: 'refund',
        amount: 700,
        status: 'succeeded',
        payment_intent: 'pi_123',
      },
    });
    expect(
      await p.createRefund({
        paymentIntentId: 'pi_123',
        amountMinor: 700,
        idempotencyKey: 'refund:admin:k',
        metadata: { reason: 'Unused' },
      }),
    ).toEqual({ id: 're_1', status: 'succeeded', amountMinor: 700, paymentIntentId: 'pi_123' });
    expect(captured[0]!.headers['idempotency-key']).toBe('refund:admin:k');
    expect(Object.fromEntries(captured[0]!.form)).toMatchObject({
      payment_intent: 'pi_123',
      amount: '700',
      'metadata[reason]': 'Unused',
    });

    reply = () => ({
      status: 200,
      body: {
        id: 're_2',
        object: 'refund',
        amount: 1,
        status: null,
        payment_intent: { id: 'pi_9' },
      },
    });
    expect(
      await p.createRefund({
        paymentIntentId: 'pi_9',
        amountMinor: 1,
        idempotencyKey: 'k2',
        metadata: {},
      }),
    ).toMatchObject({ status: 'pending', paymentIntentId: 'pi_9' });

    reply = () => ({
      status: 200,
      body: { id: 're_3', object: 'refund', amount: 1, status: 'pending', payment_intent: null },
    });
    expect(
      await p.createRefund({
        paymentIntentId: 'pi_9',
        amountMinor: 1,
        idempotencyKey: 'k3',
        metadata: {},
      }),
    ).toMatchObject({ paymentIntentId: null });
  });

  it('surfaces Stripe errors instead of swallowing them', async () => {
    reply = () => ({
      status: 400,
      body: {
        error: { type: 'invalid_request_error', code: 'amount_too_large', message: 'Too big' },
      },
    });
    await expect(
      provider().createRefund({
        paymentIntentId: 'pi_1',
        amountMinor: 1,
        idempotencyKey: 'k',
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'amount_too_large' });
  });

  it('verifies webhook signatures with the configured secret only', () => {
    const p = provider();
    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'customer.created',
      data: { object: {} },
    });
    const sign = (secret: string) =>
      new Stripe('sk_test_x').webhooks.generateTestHeaderString({ payload, secret });
    expect(p.verifyWebhook(Buffer.from(payload), sign('whsec_local')).id).toBe('evt_1');
    expect(() => p.verifyWebhook(Buffer.from(payload), sign('whsec_other'))).toThrow();
    expect(() => p.verifyWebhook(Buffer.from(`${payload} `), sign('whsec_local'))).toThrow();
    expect(p.publishableKey).toBe('pk_test_local');
  });

  it('is only built from the environment when all three Stripe keys are set', () => {
    const full = {
      STRIPE_SECRET_KEY: 'sk_test_1',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_1',
      STRIPE_WEBHOOK_SECRET: 'whsec_1',
      STRIPE_API_URL: undefined,
    };
    expect(StripePaymentProvider.fromEnv(full)).toBeInstanceOf(StripePaymentProvider);
    expect(StripePaymentProvider.fromEnv({ ...full, STRIPE_WEBHOOK_SECRET: undefined })).toBeNull();
    expect(StripePaymentProvider.fromEnv({ ...full, STRIPE_SECRET_KEY: undefined })).toBeNull();
  });
});
