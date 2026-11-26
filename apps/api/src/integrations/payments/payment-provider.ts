import Stripe from 'stripe';
import type { Env } from '../../config/env';

export type StripeEvent = Stripe.Event;

export interface ProviderIntent {
  id: string;
  clientSecret: string | null;
  status: Stripe.PaymentIntent.Status;
  amountMinor: number;
  amountReceivedMinor: number;
  currency: string;
  paymentMethodType: string | null;
  lastErrorCode: string | null;
}

export interface ProviderRefund {
  id: string;
  status: string;
  amountMinor: number;
  paymentIntentId: string | null;
}

/**
 * Everything the app needs from the payment provider. Stripe in production; a fake in tests.
 * Webhook verification is part of the provider so the secret never leaves it.
 */
export interface PaymentProvider {
  readonly publishableKey: string;
  createTopUpIntent(input: {
    amountMinor: number;
    currency: string;
    paymentId: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<ProviderIntent>;
  retrieveIntent(id: string): Promise<ProviderIntent>;
  cancelIntent(id: string): Promise<void>;
  createRefund(input: {
    paymentIntentId: string;
    amountMinor: number;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<ProviderRefund>;
  /** Throws when the signature does not match the raw body. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string): StripeEvent;
}

export function toProviderIntent(pi: Stripe.PaymentIntent): ProviderIntent {
  return {
    id: pi.id,
    clientSecret: pi.client_secret,
    status: pi.status,
    amountMinor: pi.amount,
    amountReceivedMinor: pi.amount_received,
    currency: pi.currency.toUpperCase(),
    // With a single allowed type it is exact; otherwise the method is unknown without expanding.
    paymentMethodType:
      pi.payment_method_types.length === 1 ? (pi.payment_method_types[0] ?? null) : null,
    lastErrorCode: pi.last_payment_error?.code ?? null,
  };
}

/** Stripe (or stripe-mock locally). The SDK version pins the API version. */
export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe;

  constructor(
    private readonly config: {
      secretKey: string;
      publishableKey: string;
      webhookSecret: string;
      apiUrl?: string | undefined;
    },
  ) {
    const url = config.apiUrl ? new URL(config.apiUrl) : null;
    this.stripe = new Stripe(config.secretKey, {
      maxNetworkRetries: 2,
      timeout: 15_000,
      telemetry: false,
      ...(url
        ? {
            host: url.hostname,
            port: url.port,
            protocol: url.protocol === 'http:' ? 'http' : 'https',
          }
        : {}),
    });
  }

  static fromEnv(
    env: Pick<
      Env,
      'STRIPE_SECRET_KEY' | 'STRIPE_PUBLISHABLE_KEY' | 'STRIPE_WEBHOOK_SECRET' | 'STRIPE_API_URL'
    >,
  ): StripePaymentProvider | null {
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PUBLISHABLE_KEY || !env.STRIPE_WEBHOOK_SECRET)
      return null;
    return new StripePaymentProvider({
      secretKey: env.STRIPE_SECRET_KEY,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      apiUrl: env.STRIPE_API_URL,
    });
  }

  get publishableKey(): string {
    return this.config.publishableKey;
  }

  async createTopUpIntent(input: {
    amountMinor: number;
    currency: string;
    paymentId: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<ProviderIntent> {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        // Card, Apple Pay and iDEAL as enabled in the Stripe dashboard (D15).
        automatic_payment_methods: { enabled: true },
        description: 'Training Wallet top-up',
        metadata: { paymentId: input.paymentId, userId: input.userId, purpose: 'wallet_top_up' },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return toProviderIntent(pi);
  }

  async retrieveIntent(id: string): Promise<ProviderIntent> {
    return toProviderIntent(await this.stripe.paymentIntents.retrieve(id));
  }

  async cancelIntent(id: string): Promise<void> {
    await this.stripe.paymentIntents.cancel(id);
  }

  async createRefund(input: {
    paymentIntentId: string;
    amountMinor: number;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<ProviderRefund> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountMinor,
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return {
      id: refund.id,
      status: refund.status ?? 'pending',
      amountMinor: refund.amount,
      paymentIntentId:
        typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : (refund.payment_intent?.id ?? null),
    };
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string): StripeEvent {
    return this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.config.webhookSecret);
  }
}
