import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type {
  PaymentProvider,
  ProviderIntent,
  ProviderRefund,
  StripeEvent,
} from './payment-provider';

/**
 * Test double with Stripe's real webhook signing: events built here are signed with the same
 * algorithm and verified by the same `constructEvent` code path as in production.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly publishableKey = 'pk_test_fake';
  readonly webhookSecret = 'whsec_test_fake_secret';
  readonly intents = new Map<string, ProviderIntent>();
  readonly refunds: ProviderRefund[] = [];
  readonly idempotencyKeys = new Map<string, string>();
  failNextCreate = false;
  private readonly stripe = new Stripe('sk_test_fake_offline');

  createTopUpIntent(input: {
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<ProviderIntent> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      return Promise.reject(new Error('Stripe is down'));
    }
    const existing = this.idempotencyKeys.get(input.idempotencyKey);
    if (existing) return Promise.resolve(this.intents.get(existing)!);
    const id = `pi_${randomUUID().replaceAll('-', '')}`;
    const intent: ProviderIntent = {
      id,
      clientSecret: `${id}_secret_test`,
      status: 'requires_payment_method',
      amountMinor: input.amountMinor,
      amountReceivedMinor: 0,
      currency: input.currency.toUpperCase(),
      paymentMethodType: null,
      lastErrorCode: null,
    };
    this.intents.set(id, intent);
    this.idempotencyKeys.set(input.idempotencyKey, id);
    return Promise.resolve(intent);
  }

  retrieveIntent(id: string): Promise<ProviderIntent> {
    const intent = this.intents.get(id);
    return intent ? Promise.resolve(intent) : Promise.reject(new Error(`No such intent ${id}`));
  }

  cancelIntent(id: string): Promise<void> {
    const intent = this.intents.get(id);
    if (intent) intent.status = 'canceled';
    return Promise.resolve();
  }

  createRefund(input: {
    paymentIntentId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<ProviderRefund> {
    const existing = this.refunds.find(
      (r) => r.id === this.idempotencyKeys.get(input.idempotencyKey),
    );
    if (existing) return Promise.resolve(existing);
    const refund: ProviderRefund = {
      id: `re_${randomUUID().replaceAll('-', '')}`,
      status: 'succeeded',
      amountMinor: input.amountMinor,
      paymentIntentId: input.paymentIntentId,
    };
    this.refunds.push(refund);
    this.idempotencyKeys.set(input.idempotencyKey, refund.id);
    return Promise.resolve(refund);
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string): StripeEvent {
    return this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
  }

  /** Simulates the customer completing the PaymentSheet. */
  complete(intentId: string, overrides: Partial<ProviderIntent> = {}): ProviderIntent {
    const intent = this.intents.get(intentId)!;
    Object.assign(
      intent,
      { status: 'succeeded', amountReceivedMinor: intent.amountMinor, paymentMethodType: 'card' },
      overrides,
    );
    return intent;
  }

  /** A signed webhook request body + Stripe-Signature header for the given event. */
  signedEvent(
    type: string,
    object: Record<string, unknown>,
    id = `evt_${randomUUID().replaceAll('-', '')}`,
  ) {
    const payload = JSON.stringify({
      id,
      object: 'event',
      api_version: '2026-11-18.endive',
      created: Math.floor(Date.now() / 1000),
      type,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: { object },
    });
    const signature = this.stripe.webhooks.generateTestHeaderString({
      payload,
      secret: this.webhookSecret,
    });
    return { id, payload, signature };
  }

  /** The Stripe PaymentIntent JSON for an intent in its current state. */
  intentObject(intentId: string): Record<string, unknown> {
    const i = this.intents.get(intentId)!;
    return {
      id: i.id,
      object: 'payment_intent',
      amount: i.amountMinor,
      amount_received: i.amountReceivedMinor,
      currency: i.currency.toLowerCase(),
      status: i.status,
      client_secret: i.clientSecret,
      payment_method_types: i.paymentMethodType ? [i.paymentMethodType] : ['card', 'ideal'],
      last_payment_error: i.lastErrorCode ? { code: i.lastErrorCode } : null,
      metadata: {},
    };
  }
}
