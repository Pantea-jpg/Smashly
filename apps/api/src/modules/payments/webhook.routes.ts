import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { ApiErrorSchema } from '@tw/contracts';
import express, { Router } from 'express';
import { z } from 'zod';
import { AppError, isAppError } from '../../core/errors/app-error';
import type { PaymentsService } from './payments.service';

const WEBHOOK_BODY_LIMIT = '1mb';

/**
 * POST /api/v1/webhooks/stripe — mounted BEFORE express.json(): the signature is computed
 * over the exact raw bytes, so the body must not be parsed first. No JWT; the Stripe
 * signature (shared secret, 5-minute tolerance) is the authentication.
 * 2xx is returned only after the event is stored and applied; failures return 5xx so
 * Stripe retries (duplicates are recognised by event id).
 */
export function stripeWebhookRouter(payments: PaymentsService): Router {
  const router = Router();
  router.post(
    '/stripe',
    express.raw({ type: '*/*', limit: WEBHOOK_BODY_LIMIT }),
    async (req, res) => {
      const signature = req.get('stripe-signature');
      if (!signature || !Buffer.isBuffer(req.body)) {
        throw AppError.validation({ header: 'stripe-signature' }, 'Missing Stripe signature');
      }
      let event;
      try {
        event = payments.verifyWebhook(req.body, signature);
      } catch (error) {
        if (isAppError(error)) throw error;
        req.log.warn('rejected Stripe webhook with an invalid signature');
        throw AppError.validation(undefined, 'Invalid webhook signature');
      }
      const outcome = await payments.handleEvent(event);
      res.status(200).json({ received: true, duplicate: outcome === 'duplicate' });
    },
  );
  return router;
}

export function documentStripeWebhook(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/webhooks/stripe',
    summary: 'Stripe webhook (signed)',
    description:
      'Handled: payment_intent.succeeded/processing/payment_failed/canceled, refund.created/updated/failed, charge.dispute.created/closed. Other events are stored and acknowledged.',
    tags: ['Webhooks'],
    request: {
      headers: z.object({ 'stripe-signature': z.string() }),
      body: { content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
    responses: {
      200: {
        description: 'Stored and applied (or a duplicate)',
        content: {
          'application/json': {
            schema: z.object({ received: z.literal(true), duplicate: z.boolean() }),
          },
        },
      },
      400: {
        description: 'Invalid signature',
        content: { 'application/json': { schema: ApiErrorSchema } },
      },
      503: {
        description: 'Payments not configured',
        content: { 'application/json': { schema: ApiErrorSchema } },
      },
    },
  });
}
