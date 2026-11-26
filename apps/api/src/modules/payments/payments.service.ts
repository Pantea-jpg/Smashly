import type { LedgerResult, PaymentStatus, TopUpIntent } from '@tw/contracts';
import { DEFAULT_CURRENCY } from '@tw/money';
import { writeAudit } from '../../core/audit/audit';
import { type AuditContext, SYSTEM_CONTEXT } from '../../core/context/request-context';
import { isUniqueViolation, type Prisma, type PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { Logger } from '../../core/logger/logger';
import { alerts } from '../../core/observability/alerts';
import {
  type PaymentProvider,
  type ProviderIntent,
  type StripeEvent,
  toProviderIntent,
} from '../../integrations/payments/payment-provider';
import type { SettingsService } from '../admin/settings.service';
import { notifyUsers } from '../notifications/notify';
import { emitRealtime, rooms } from '../realtime/realtime';
import type { LedgerService } from '../wallets/ledger.service';
import { money } from '../wallets/mappers';

type Tx = Prisma.TransactionClient;
type PaymentRow = Prisma.PaymentGetPayload<object>;

/** Statuses after which the wallet has been credited for this payment. */
const CREDITED: readonly PaymentStatus[] = [
  'SUCCEEDED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DISPUTED',
];
const SWEEP_AFTER_MS = 15 * 60_000;
const ABANDON_AFTER_MS = 24 * 60 * 60_000;

/**
 * Online top-ups (Stripe PaymentIntents). The wallet is credited ONLY from verified provider
 * state: a signed webhook, or the sweeper asking Stripe directly. Never from the app.
 */
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly provider: PaymentProvider | null,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private requireProvider(): PaymentProvider {
    if (!this.provider)
      throw new AppError('PAYMENTS_UNAVAILABLE', 'Online payments are not configured');
    return this.provider;
  }

  // ── Creating a top-up ───────────────────────────────────────────────────

  async createTopUp(
    userId: string,
    input: { amountMinor: number; currency: string },
    clientIdempotencyKey: string,
    ctx: AuditContext,
  ): Promise<TopUpIntent> {
    const provider = this.requireProvider();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallets: { where: { currency: DEFAULT_CURRENCY } } },
    });
    const wallet = user?.wallets[0];
    if (!user || !wallet || user.role !== 'USER') throw AppError.notFound('Wallet');
    if (!user.emailVerifiedAt) {
      throw new AppError('EMAIL_NOT_VERIFIED', 'Confirm your email address before topping up');
    }
    if (input.currency !== wallet.currency) {
      throw AppError.validation({ currency: 'unsupported' }, 'Unsupported currency');
    }

    const [min, max, maxBalance] = await Promise.all([
      this.settings.get('wallet.topUpMinMinor'),
      this.settings.get('wallet.topUpMaxMinor'),
      this.settings.get('wallet.maxBalanceMinor'),
    ]);
    if (input.amountMinor < min || input.amountMinor > max) {
      throw new AppError('AMOUNT_OUT_OF_RANGE', 'Top-up amount is outside the allowed range', {
        minMinor: min,
        maxMinor: max,
      });
    }
    const total = wallet.balanceMinor + input.amountMinor;
    if (total - Math.min(wallet.debtMinor, total) > maxBalance) {
      throw new AppError('BALANCE_LIMIT_EXCEEDED', 'This would exceed the maximum wallet balance', {
        maxBalanceMinor: maxBalance,
      });
    }

    let payment: PaymentRow;
    try {
      payment = await this.prisma.payment.create({
        data: {
          userId,
          walletId: wallet.id,
          amountMinor: input.amountMinor,
          currency: wallet.currency,
          clientIdempotencyKey,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Same client key again (app retry): return the same intent, never a second one.
      payment = await this.prisma.payment.findUniqueOrThrow({
        where: { userId_clientIdempotencyKey: { userId, clientIdempotencyKey } },
      });
      if (payment.amountMinor !== input.amountMinor) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was used for a different amount',
        );
      }
    }

    let intent: ProviderIntent;
    try {
      intent = payment.providerPaymentId
        ? await provider.retrieveIntent(payment.providerPaymentId)
        : await provider.createTopUpIntent({
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            paymentId: payment.id,
            userId,
            idempotencyKey: `topup:${payment.id}`,
          });
    } catch (error) {
      this.logger.error(
        { err: error, paymentId: payment.id },
        'payment provider failed to create intent',
      );
      throw new AppError(
        'PAYMENT_PROVIDER_ERROR',
        'The payment provider is unavailable',
        undefined,
        {
          cause: error,
        },
      );
    }
    if (!payment.providerPaymentId) {
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { providerPaymentId: intent.id },
        });
        await writeAudit(tx, ctx, {
          action: 'payment.top_up_created',
          entityType: 'Payment',
          entityId: payment.id,
          after: { amountMinor: payment.amountMinor, providerPaymentId: intent.id },
        });
      });
    }
    if (!intent.clientSecret) throw new AppError('PAYMENT_PROVIDER_ERROR', 'Missing client secret');

    return {
      paymentId: payment.id,
      clientSecret: intent.clientSecret,
      publishableKey: provider.publishableKey,
      amount: money(payment.amountMinor, payment.currency),
    };
  }

  // ── Webhooks ────────────────────────────────────────────────────────────

  verifyWebhook(rawBody: Buffer, signature: string): StripeEvent {
    return this.requireProvider().verifyWebhook(rawBody, signature);
  }

  /**
   * Stores the event once (duplicates are acknowledged and ignored) and applies it in one
   * transaction. Errors are recorded on the event and rethrown so Stripe retries.
   */
  async handleEvent(event: StripeEvent): Promise<'processed' | 'duplicate'> {
    try {
      await this.prisma.stripeEvent.create({
        data: {
          id: event.id,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Lock the event row: concurrent deliveries of the same event are serialised.
          const rows = await tx.$queryRaw<{ processed_at: Date | null }[]>`
            SELECT processed_at FROM stripe_events WHERE id = ${event.id} FOR UPDATE`;
          if (rows[0]?.processed_at) return 'duplicate' as const;
          await this.apply(tx, event);
          await tx.stripeEvent.update({
            where: { id: event.id },
            data: { processedAt: this.now(), error: null },
          });
          return 'processed' as const;
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      await this.prisma.stripeEvent.update({
        where: { id: event.id },
        data: { error: error instanceof Error ? error.message.slice(0, 2000) : String(error) },
      });
      // Stripe retries for up to 3 days, but money may be waiting: tell an operator now.
      alerts.critical(
        this.logger,
        'stripe_webhook_failed',
        'a Stripe event could not be processed',
        {
          stripeEventId: event.id,
          type: event.type,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        },
      );
      throw error;
    }
  }

  private async apply(tx: Tx, event: StripeEvent): Promise<void> {
    // We subscribe to a handful of the ~300 Stripe event types; the rest fall to default.
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
    switch (event.type) {
      case 'payment_intent.succeeded':
      case 'payment_intent.processing':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const pi = event.data.object;
        const payment = await this.findPayment(tx, pi.id, pi.metadata?.['paymentId']);
        if (!payment) return this.ignore(event, 'unknown payment intent');
        await this.applyIntent(tx, payment, toProviderIntent(pi));
        return;
      }
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed': {
        const refund = event.data.object;
        const piId =
          typeof refund.payment_intent === 'string'
            ? refund.payment_intent
            : refund.payment_intent?.id;
        const payment = piId ? await this.findPayment(tx, piId) : null;
        if (!payment) return this.ignore(event, 'refund for unknown payment');
        // Serialises events about one payment (Stripe sends refund.created, refund.updated and
        // refund.failed in no guaranteed order, possibly at the same time).
        await this.lockPayment(tx, payment.id);
        if (refund.status === 'succeeded' || refund.status === 'pending') {
          await this.recordRefund(tx, payment, {
            refundId: refund.id,
            amountMinor: refund.amount,
            adminId: refund.metadata?.['adminId'] ?? null,
            reason: refund.metadata?.['reason'] ?? 'Refunded to the original payment method',
          });
        } else if (refund.status === 'failed' || refund.status === 'canceled') {
          await this.undoFailedRefund(tx, payment, refund.id, refund.amount);
        }
        return;
      }
      case 'charge.dispute.created': {
        const dispute = event.data.object;
        const piId =
          typeof dispute.payment_intent === 'string'
            ? dispute.payment_intent
            : dispute.payment_intent?.id;
        const payment = piId ? await this.findPayment(tx, piId) : null;
        if (!payment) return this.ignore(event, 'dispute for unknown payment');
        await this.lockPayment(tx, payment.id); // same lock order as refunds: payment, then wallet
        // Stripe withdraws the disputed amount: debit it, the uncovered part becomes debt (D18).
        await this.ledger.debitExternal(
          tx,
          {
            userId: payment.userId,
            currency: payment.currency,
            amountMinor: dispute.amount,
            idempotencyKey: `stripe_dispute:${dispute.id}`,
            paymentId: payment.id,
            description: 'Card payment disputed',
            reason: `Chargeback (${dispute.reason})`,
          },
          SYSTEM_CONTEXT,
        );
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'DISPUTED' } });
        return;
      }
      case 'charge.dispute.closed': {
        const dispute = event.data.object;
        const piId =
          typeof dispute.payment_intent === 'string'
            ? dispute.payment_intent
            : dispute.payment_intent?.id;
        const payment = piId ? await this.findPayment(tx, piId) : null;
        if (!payment) return this.ignore(event, 'dispute for unknown payment');
        if (dispute.status === 'won') {
          await this.lockPayment(tx, payment.id);
          const { created } = await this.ledger.creditSystem(
            tx,
            {
              userId: payment.userId,
              currency: payment.currency,
              amountMinor: dispute.amount,
              idempotencyKey: `stripe_dispute_won:${dispute.id}`,
              paymentId: payment.id,
              description: 'Chargeback reversed',
              reason: 'Chargeback decided in our favour; funds returned',
            },
            SYSTEM_CONTEXT,
          );
          if (created) {
            const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
            await tx.payment.update({
              where: { id: payment.id },
              data: {
                status: current.refundedAmountMinor > 0 ? 'PARTIALLY_REFUNDED' : 'SUCCEEDED',
              },
            });
          }
        }
        return;
      }
      default:
        // Acknowledged and stored; nothing to do for other event types.
        return;
    }
  }

  private ignore(event: StripeEvent, why: string): void {
    this.logger.warn({ stripeEventId: event.id, type: event.type }, `stripe event ignored: ${why}`);
  }

  /** Row lock on the payment: taken before the wallet lock wherever both are needed. */
  private async lockPayment(tx: Tx, paymentId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
  }

  /**
   * Whether Stripe already told us this refund failed or was canceled (both are final).
   * A late "pending" or "succeeded" event for it must then not debit the wallet.
   */
  private async refundKnownFailed(tx: Tx, refundId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stripe_events
      WHERE type IN ('refund.created', 'refund.updated', 'refund.failed')
        AND payload->'data'->'object'->>'id' = ${refundId}
        AND payload->'data'->'object'->>'status' IN ('failed', 'canceled')`;
    return (rows[0]?.n ?? 0) > 0;
  }

  private findPayment(
    tx: Tx,
    providerPaymentId: string,
    paymentId?: string,
  ): Promise<PaymentRow | null> {
    return tx.payment.findFirst({
      where: { OR: [{ providerPaymentId }, ...(paymentId ? [{ id: paymentId }] : [])] },
    });
  }

  /**
   * Applies provider state to a payment. Status only moves forward, so out-of-order events
   * (e.g. "processing" after "succeeded") never regress it. Credits exactly once.
   */
  private async applyIntent(tx: Tx, payment: PaymentRow, intent: ProviderIntent): Promise<void> {
    await this.applyIntentStatus(tx, payment, intent);
    // The app's top-up screen refetches the status (it polls too, in case the socket is down).
    await emitRealtime(tx, {
      room: rooms.user(payment.userId),
      event: 'payment.updated',
      data: { paymentId: payment.id },
    });
  }

  private async applyIntentStatus(
    tx: Tx,
    payment: PaymentRow,
    intent: ProviderIntent,
  ): Promise<void> {
    const locked = await tx.$queryRaw<{ status: PaymentStatus }[]>`
      SELECT status FROM payments WHERE id = ${payment.id}::uuid FOR UPDATE`;
    const status = locked[0]?.status ?? payment.status;
    if (CREDITED.includes(status) || status === 'REQUIRES_REVIEW' || status === 'CANCELED') {
      return;
    }

    switch (intent.status) {
      case 'succeeded': {
        if (
          intent.amountReceivedMinor !== payment.amountMinor ||
          intent.currency !== payment.currency
        ) {
          // Never credit an amount we did not agree on: an admin reviews it.
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'REQUIRES_REVIEW' },
          });
          await writeAudit(tx, SYSTEM_CONTEXT, {
            action: 'payment.requires_review',
            entityType: 'Payment',
            entityId: payment.id,
            after: {
              expectedMinor: payment.amountMinor,
              receivedMinor: intent.amountReceivedMinor,
              currency: intent.currency,
            },
          });
          alerts.critical(
            this.logger,
            'payment_requires_review',
            'Stripe amount or currency differs',
            {
              paymentId: payment.id,
              expectedMinor: payment.amountMinor,
              receivedMinor: intent.amountReceivedMinor,
              currency: intent.currency,
            },
          );
          return;
        }
        if (!payment.providerPaymentId) {
          await tx.payment.update({
            where: { id: payment.id },
            data: { providerPaymentId: intent.id },
          });
        }
        await this.ledger.creditOnlineTopUp(
          tx,
          {
            id: payment.id,
            userId: payment.userId,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            providerPaymentId: intent.id,
          },
          SYSTEM_CONTEXT,
        );
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'SUCCEEDED',
            succeededAt: this.now(),
            methodType: intent.paymentMethodType,
            failureCode: null,
          },
        });
        return;
      }
      case 'processing':
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'PROCESSING' } });
        return;
      case 'requires_payment_method':
        // A failed attempt; the customer may still retry with another method.
        if (intent.lastErrorCode) {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'FAILED', failureCode: intent.lastErrorCode },
          });
          await notifyUsers(tx, {
            userIds: [payment.userId],
            type: 'TOP_UP_FAILED',
            category: 'PAYMENTS',
            params: {
              amountMinor: payment.amountMinor,
              currency: payment.currency,
              paymentId: payment.id,
            },
            dedupeKey: `payment_failed:${payment.id}`,
          });
        }
        return;
      case 'canceled':
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'CANCELED' } });
        return;
      case 'requires_action':
      case 'requires_confirmation':
      case 'requires_capture':
        // Still with the customer (3-D Secure, confirmation) or not captured: nothing to record.
        return;
    }
  }

  private async recordRefund(
    tx: Tx,
    payment: PaymentRow,
    refund: { refundId: string; amountMinor: number; adminId: string | null; reason: string },
  ): Promise<LedgerResult | null> {
    // Out of order: "failed" arrived (and found nothing to undo) before this "pending" event.
    if (await this.refundKnownFailed(tx, refund.refundId)) {
      this.logger.warn({ refundId: refund.refundId }, 'late event for a failed refund ignored');
      return null;
    }
    const { result, created } = await this.ledger.debitExternal(
      tx,
      {
        userId: payment.userId,
        currency: payment.currency,
        amountMinor: refund.amountMinor,
        idempotencyKey: `stripe_refund:${refund.refundId}`,
        paymentId: payment.id,
        description: 'Refund to card',
        reason: refund.reason,
        adminId: refund.adminId,
      },
      SYSTEM_CONTEXT,
    );
    if (created) {
      const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const refunded = Math.min(
        current.amountMinor,
        current.refundedAmountMinor + refund.amountMinor,
      );
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          refundedAmountMinor: refunded,
          ...(current.status === 'DISPUTED'
            ? {}
            : { status: refunded >= current.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED' }),
        },
      });
    }
    return result;
  }

  /** A refund we already debited failed at the bank: give the money back. */
  private async undoFailedRefund(
    tx: Tx,
    payment: PaymentRow,
    refundId: string,
    amountMinor: number,
  ): Promise<void> {
    const debited = await tx.walletTransaction.findUnique({
      where: { idempotencyKey: `stripe_refund:${refundId}` },
    });
    // Not debited yet: nothing to undo. A late "pending" event is refused by refundKnownFailed.
    if (!debited) return;
    const { created } = await this.ledger.creditSystem(
      tx,
      {
        userId: payment.userId,
        currency: payment.currency,
        amountMinor,
        idempotencyKey: `stripe_refund_failed:${refundId}`,
        paymentId: payment.id,
        description: 'Card refund failed',
        reason: 'Card refund failed; amount returned to the wallet',
      },
      SYSTEM_CONTEXT,
    );
    // refund.failed and refund.updated both report the failure: adjust the payment once.
    if (!created) return;
    const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const refunded = Math.max(0, current.refundedAmountMinor - amountMinor);
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        refundedAmountMinor: refunded,
        status: refunded > 0 ? 'PARTIALLY_REFUNDED' : 'SUCCEEDED',
      },
    });
  }

  // ── Admin: refund unused balance to the card (D17) ───────────────────────

  async refundToCard(
    input: {
      userId: string;
      paymentId: string;
      amountMinor: number;
      reason: string;
      adminId: string;
      idempotencyKey: string;
    },
    ctx: AuditContext,
  ): Promise<LedgerResult> {
    const provider = this.requireProvider();
    const payment = await this.prisma.payment.findFirst({
      where: { id: input.paymentId, userId: input.userId },
    });
    if (!payment?.providerPaymentId) throw AppError.notFound('Payment');
    if (payment.status !== 'SUCCEEDED' && payment.status !== 'PARTIALLY_REFUNDED') {
      throw new AppError('CONFLICT', 'Only successful online top-ups can be refunded');
    }
    if (input.amountMinor > payment.amountMinor - payment.refundedAmountMinor) {
      throw new AppError(
        'AMOUNT_OUT_OF_RANGE',
        'Refund exceeds the refundable amount of this payment',
      );
    }
    const wallet = await this.prisma.wallet.findUniqueOrThrow({ where: { id: payment.walletId } });
    if (input.amountMinor > wallet.balanceMinor) {
      throw new AppError('INSUFFICIENT_BALANCE', 'Refund exceeds the wallet balance');
    }

    // Stripe first (idempotent per admin + key), then the ledger keyed on the refund id:
    // a retry after a crash finds the same refund and posts the ledger row exactly once.
    let refund;
    try {
      refund = await provider.createRefund({
        paymentIntentId: payment.providerPaymentId,
        amountMinor: input.amountMinor,
        idempotencyKey: `refund:${input.adminId}:${input.idempotencyKey}`,
        metadata: {
          adminId: input.adminId,
          paymentId: payment.id,
          reason: input.reason.slice(0, 400),
        },
      });
    } catch (error) {
      this.logger.error({ err: error, paymentId: payment.id }, 'stripe refund failed');
      throw new AppError('PAYMENT_PROVIDER_ERROR', 'The refund could not be created', undefined, {
        cause: error,
      });
    }
    if (refund.status === 'failed' || refund.status === 'canceled') {
      throw new AppError('PAYMENT_PROVIDER_ERROR', 'Stripe reported the refund as failed');
    }
    return this.ledger.run(undefined, async (tx) => {
      await this.lockPayment(tx, payment.id);
      const result = await this.recordRefund(tx, payment, {
        refundId: refund.id,
        amountMinor: refund.amountMinor,
        adminId: input.adminId,
        reason: input.reason,
      });
      if (!result) {
        throw new AppError('PAYMENT_PROVIDER_ERROR', 'Stripe reported the refund as failed');
      }
      await writeAudit(tx, ctx, {
        action: 'payment.refunded_to_card',
        entityType: 'Payment',
        entityId: payment.id,
        after: { refundId: refund.id, amountMinor: refund.amountMinor, reason: input.reason },
      });
      return result;
    });
  }

  // ── Sweeper: payments whose webhook never arrived ────────────────────────

  async sweep(): Promise<{ checked: number; credited: number; abandoned: number }> {
    if (!this.provider) return { checked: 0, credited: 0, abandoned: 0 };
    const now = this.now();
    const stale = await this.prisma.payment.findMany({
      where: {
        status: { in: ['REQUIRES_PAYMENT', 'PROCESSING', 'FAILED'] },
        providerPaymentId: { not: null },
        createdAt: { lt: new Date(now.getTime() - SWEEP_AFTER_MS) },
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });

    let credited = 0;
    let abandoned = 0;
    for (const payment of stale) {
      try {
        const intent = await this.provider.retrieveIntent(payment.providerPaymentId!);
        if (intent.status === 'succeeded') credited += 1;
        const old = payment.createdAt.getTime() < now.getTime() - ABANDON_AFTER_MS;
        if (
          old &&
          (intent.status === 'requires_payment_method' || intent.status === 'requires_action')
        ) {
          await this.provider.cancelIntent(intent.id);
          intent.status = 'canceled';
          abandoned += 1;
        }
        await this.prisma.$transaction((tx) => this.applyIntent(tx, payment, intent), {
          timeout: 30_000,
        });
      } catch (error) {
        this.logger.error(
          { err: error, paymentId: payment.id },
          'payment sweep failed for payment',
        );
      }
    }
    return { checked: stale.length, credited, abandoned };
  }
}
