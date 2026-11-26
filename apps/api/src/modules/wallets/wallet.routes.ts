import {
  AdjustmentRequestSchema,
  AdminPaymentQuerySchema,
  AdminPaymentSchema,
  AdminTransactionQuerySchema,
  AdminTransactionSchema,
  AdminWalletQuerySchema,
  AdminWalletSchema,
  CashPaymentRequestSchema,
  CreateTopUpRequestSchema,
  DebtSchema,
  IDEMPOTENCY_HEADER,
  IdempotencyKeySchema,
  IdSchema,
  LedgerResultSchema,
  PaymentSchema,
  RefundRequestSchema,
  ReversalRequestSchema,
  TopUpIntentSchema,
  TransactionQuerySchema,
  TransactionSchema,
  UserIdParamsSchema,
  WalletSchema,
} from '@tw/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { auditContextOf, requireActor, requireSubjectId } from '../../core/context/request-context';
import type { PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { ApiRouter } from '../../core/http/api-router';
import { idempotency } from '../../core/idempotency/idempotency';
import type { PaymentsService } from '../payments/payments.service';
import type { LedgerService } from './ledger.service';
import type { WalletQueryService } from './wallet-query.service';

const IdParams = z.object({ id: IdSchema });

function idempotencyKeyOf(req: Request): string {
  const parsed = IdempotencyKeySchema.safeParse(req.get(IDEMPOTENCY_HEADER));
  if (!parsed.success) {
    throw AppError.validation(
      { header: IDEMPOTENCY_HEADER },
      'A valid Idempotency-Key header is required',
    );
  }
  return parsed.data;
}

/** The signed-in user's (or, in View-as mode, the viewed user's) wallet. */
export function registerMeWalletRoutes(
  api: ApiRouter,
  deps: { queries: WalletQueryService; payments: PaymentsService },
): void {
  const tags: [string] = ['Me · Wallet'];

  api.route(
    {
      method: 'get',
      path: '/wallet',
      summary: 'Wallet balance, outstanding debt and top-up limits',
      tags,
      auth: 'authenticated',
      response: { status: 200, schema: WalletSchema },
      errors: ['NOT_FOUND'],
    },
    ({ req }) => deps.queries.getWallet(requireSubjectId(req)),
  );

  api.cursorList(
    {
      method: 'get',
      path: '/transactions',
      summary: 'Wallet transactions, newest first',
      tags,
      auth: 'authenticated',
      request: { query: TransactionQuerySchema },
      item: TransactionSchema,
    },
    ({ req, query }) => deps.queries.listTransactions(requireSubjectId(req), query),
  );

  api.route(
    {
      method: 'get',
      path: '/transactions/:id',
      summary: 'One wallet transaction',
      tags,
      auth: 'authenticated',
      request: { params: IdParams },
      response: { status: 200, schema: TransactionSchema },
      errors: ['NOT_FOUND'],
    },
    ({ req, params }) => deps.queries.getTransaction(requireSubjectId(req), params.id),
  );

  api.route(
    {
      method: 'get',
      path: '/debts',
      summary: 'Outstanding and settled debts',
      tags,
      auth: 'authenticated',
      response: { status: 200, schema: z.array(DebtSchema) },
    },
    ({ req }) => deps.queries.listDebts(requireSubjectId(req)),
  );

  api.route(
    {
      method: 'post',
      path: '/wallet/top-ups',
      summary: 'Start an online top-up (Stripe PaymentSheet)',
      description:
        'Returns a client secret for the PaymentSheet. The wallet is credited only when Stripe confirms the payment (webhook); poll GET /me/payments/{id} or wait for the realtime event. Repeating the same Idempotency-Key returns the same payment.',
      tags,
      auth: 'authenticated',
      idempotencyKey: 'required',
      request: { body: CreateTopUpRequestSchema },
      response: { status: 201, schema: TopUpIntentSchema },
      errors: [
        'EMAIL_NOT_VERIFIED',
        'AMOUNT_OUT_OF_RANGE',
        'BALANCE_LIMIT_EXCEEDED',
        'IDEMPOTENCY_KEY_REUSED',
        'PAYMENTS_UNAVAILABLE',
        'PAYMENT_PROVIDER_ERROR',
      ],
    },
    ({ req, body }) =>
      deps.payments.createTopUp(
        requireSubjectId(req),
        body,
        idempotencyKeyOf(req),
        auditContextOf(req),
      ),
  );

  api.route(
    {
      method: 'get',
      path: '/payments',
      summary: 'Online top-up attempts',
      tags,
      auth: 'authenticated',
      response: { status: 200, schema: z.array(PaymentSchema) },
    },
    ({ req }) => deps.queries.listUserPayments(requireSubjectId(req)),
  );

  api.route(
    {
      method: 'get',
      path: '/payments/:id',
      summary: 'Status of one online top-up',
      tags,
      auth: 'authenticated',
      request: { params: IdParams },
      response: { status: 200, schema: PaymentSchema },
      errors: ['NOT_FOUND'],
    },
    ({ req, params }) => deps.queries.getPayment(requireSubjectId(req), params.id),
  );
}

/** Admin money operations. Every write requires an Idempotency-Key and is audited. */
export function registerAdminMoneyRoutes(
  api: ApiRouter,
  deps: {
    prisma: PrismaClient;
    ledger: LedgerService;
    queries: WalletQueryService;
    payments: PaymentsService;
  },
): void {
  const tags: [string] = ['Admin · Money'];
  const requireKey = idempotency(deps.prisma, { required: true });

  api.offsetList(
    {
      method: 'get',
      path: '/wallets',
      summary: 'All wallets with balance and debt',
      tags,
      auth: 'admin',
      request: { query: AdminWalletQuerySchema },
      item: AdminWalletSchema,
    },
    ({ query }) => deps.queries.listWallets(query),
  );

  api.offsetList(
    {
      method: 'get',
      path: '/transactions',
      summary: 'Ledger across all wallets',
      tags,
      auth: 'admin',
      request: { query: AdminTransactionQuerySchema },
      item: AdminTransactionSchema,
    },
    ({ query }) => deps.queries.listAdminTransactions(query),
  );

  api.route(
    {
      method: 'get',
      path: '/transactions/:id',
      summary: 'A transaction with its group (debt settlements) and reversal links',
      tags,
      auth: 'admin',
      request: { params: IdParams },
      response: {
        status: 200,
        schema: z.object({
          transaction: AdminTransactionSchema,
          related: z.array(AdminTransactionSchema),
        }),
      },
      errors: ['NOT_FOUND'],
    },
    ({ params }) => deps.queries.getAdminTransaction(params.id),
  );

  api.route(
    {
      method: 'post',
      path: '/transactions/:id/reversal',
      summary: 'Reverse a transaction with a REVERSAL entry',
      description:
        'Cash top-ups, credit/debit adjustments and cash refunds. Training charges are corrected via attendance; online top-ups via card refunds. A reversed credit that was already spent creates debt.',
      tags,
      auth: 'admin',
      idempotencyKey: 'required',
      middleware: [requireKey],
      request: { params: IdParams, body: ReversalRequestSchema },
      response: { status: 201, schema: LedgerResultSchema },
      errors: ['NOT_FOUND', 'ALREADY_REVERSED', 'NOT_REVERSIBLE', 'IDEMPOTENCY_KEY_REUSED'],
    },
    ({ req, params, body }) =>
      deps.ledger.reverse(
        { transactionId: params.id, reason: body.reason, adminId: requireActor(req).id },
        auditContextOf(req),
      ),
  );

  api.route(
    {
      method: 'post',
      path: '/users/:id/cash-payments',
      summary: 'Record cash received from a user',
      description:
        'Credits the wallet (settling any outstanding debt first) and notifies the user.',
      tags,
      auth: 'admin',
      idempotencyKey: 'required',
      middleware: [requireKey],
      request: { params: UserIdParamsSchema, body: CashPaymentRequestSchema },
      response: { status: 201, schema: LedgerResultSchema },
      errors: ['NOT_FOUND', 'BALANCE_LIMIT_EXCEEDED', 'IDEMPOTENCY_KEY_REUSED'],
    },
    ({ req, params, body }) =>
      deps.ledger.creditCash(
        {
          userId: params.id,
          amountMinor: body.amountMinor,
          description: body.description,
          adminId: requireActor(req).id,
          idempotencyKey: idempotencyKeyOf(req),
        },
        auditContextOf(req),
      ),
  );

  api.route(
    {
      method: 'post',
      path: '/users/:id/adjustments',
      summary: 'Correct a wallet: credit, debit or waive debt (reason required)',
      tags,
      auth: 'admin',
      idempotencyKey: 'required',
      middleware: [requireKey],
      request: { params: UserIdParamsSchema, body: AdjustmentRequestSchema },
      response: { status: 201, schema: LedgerResultSchema },
      errors: [
        'NOT_FOUND',
        'INSUFFICIENT_BALANCE',
        'AMOUNT_OUT_OF_RANGE',
        'IDEMPOTENCY_KEY_REUSED',
      ],
    },
    ({ req, params, body }) =>
      deps.ledger.adjust(
        {
          userId: params.id,
          ...body,
          adminId: requireActor(req).id,
          idempotencyKey: idempotencyKeyOf(req),
        },
        auditContextOf(req),
      ),
  );

  api.route(
    {
      method: 'post',
      path: '/users/:id/refunds',
      summary: 'Pay unused balance back, in cash or to the card of an online top-up',
      tags,
      auth: 'admin',
      idempotencyKey: 'required',
      middleware: [requireKey],
      request: { params: UserIdParamsSchema, body: RefundRequestSchema },
      response: { status: 201, schema: LedgerResultSchema },
      errors: [
        'NOT_FOUND',
        'INSUFFICIENT_BALANCE',
        'AMOUNT_OUT_OF_RANGE',
        'CONFLICT',
        'PAYMENTS_UNAVAILABLE',
        'PAYMENT_PROVIDER_ERROR',
      ],
    },
    ({ req, params, body }) => {
      const common = {
        userId: params.id,
        amountMinor: body.amountMinor,
        reason: body.reason,
        adminId: requireActor(req).id,
        idempotencyKey: idempotencyKeyOf(req),
      };
      return body.method === 'CASH'
        ? deps.ledger.refundCash(common, auditContextOf(req))
        : deps.payments.refundToCard(
            { ...common, paymentId: body.paymentId! },
            auditContextOf(req),
          );
    },
  );

  api.cursorList(
    {
      method: 'get',
      path: '/users/:id/transactions',
      summary: "A user's ledger, newest first",
      tags,
      auth: 'admin',
      request: { params: UserIdParamsSchema, query: TransactionQuerySchema },
      item: AdminTransactionSchema,
    },
    ({ params, query }) => deps.queries.listAdminUserTransactions(params.id, query),
  );

  api.route(
    {
      method: 'get',
      path: '/users/:id/debts',
      summary: "A user's debts",
      tags,
      auth: 'admin',
      request: { params: UserIdParamsSchema },
      response: { status: 200, schema: z.array(DebtSchema) },
    },
    ({ params }) => deps.queries.listDebts(params.id),
  );

  api.route(
    {
      method: 'get',
      path: '/users/:id/payments',
      summary: "A user's online top-ups",
      tags,
      auth: 'admin',
      request: { params: UserIdParamsSchema },
      response: { status: 200, schema: z.array(PaymentSchema) },
    },
    ({ params }) => deps.queries.listUserPayments(params.id),
  );

  api.offsetList(
    {
      method: 'get',
      path: '/payments',
      summary: 'Online top-ups across all users (filter REQUIRES_REVIEW for mismatches)',
      tags,
      auth: 'admin',
      request: { query: AdminPaymentQuerySchema },
      item: AdminPaymentSchema,
    },
    ({ query }) => deps.queries.listAdminPayments(query),
  );
}
