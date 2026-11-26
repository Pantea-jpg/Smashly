import { z } from 'zod';
import {
  CurrencySchema,
  CursorQuerySchema,
  IdSchema,
  IsoDateTimeSchema,
  MoneySchema,
  OffsetQuerySchema,
  sortQuerySchema,
} from './common';
import { DebtSource, DebtStatus, PaymentMethod, PaymentStatus, TransactionType } from './enums';

/** Positive integer minor units for amounts typed by people (cash, refunds, adjustments). */
export const PositiveAmountSchema = z.number().int().positive().max(1_000_000_00);

const ReasonSchema = z.string().trim().min(3, { message: 'required' }).max(500);

// ── Wallet ──────────────────────────────────────────────────────────────────

export const TopUpLimitsSchema = z.object({
  minMinor: z.number().int(),
  maxMinor: z.number().int(),
  maxBalanceMinor: z.number().int(),
  presetsMinor: z.array(z.number().int()),
});
export type TopUpLimits = z.infer<typeof TopUpLimitsSchema>;

export const WalletSchema = z.object({
  id: IdSchema,
  balance: MoneySchema,
  debt: MoneySchema,
  topUpLimits: TopUpLimitsSchema,
  /** Online top-ups require a confirmed email address. */
  canTopUp: z.boolean(),
});
export type Wallet = z.infer<typeof WalletSchema>;

// ── Ledger ──────────────────────────────────────────────────────────────────

/** POSTED, or REVERSED when a later REVERSAL row points at it (ledger rows never change). */
export const TransactionStatus = z.enum(['POSTED', 'REVERSED']);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

export const TransactionSchema = z.object({
  id: IdSchema,
  type: TransactionType,
  status: TransactionStatus,
  amount: MoneySchema,
  walletDelta: MoneySchema,
  debtDelta: MoneySchema,
  balanceAfter: MoneySchema,
  debtAfter: MoneySchema,
  paymentMethod: PaymentMethod,
  description: z.string(),
  reason: z.string().nullable(),
  trainingId: IdSchema.nullable(),
  paymentId: IdSchema.nullable(),
  reversesTransactionId: IdSchema.nullable(),
  reversedByTransactionId: IdSchema.nullable(),
  groupId: IdSchema,
  createdAt: IsoDateTimeSchema,
});
export type Transaction = z.infer<typeof TransactionSchema>;

/** Admin view adds who recorded it and the balances before. */
export const AdminTransactionSchema = TransactionSchema.extend({
  userId: IdSchema,
  sequence: z.number().int(),
  balanceBefore: MoneySchema,
  debtBefore: MoneySchema,
  createdByAdminId: IdSchema.nullable(),
});
export type AdminTransaction = z.infer<typeof AdminTransactionSchema>;

export const TransactionQuerySchema = CursorQuerySchema.extend({
  type: TransactionType.optional(),
});

export const AdminTransactionQuerySchema = OffsetQuerySchema.extend({
  type: TransactionType.optional(),
  userId: IdSchema.optional(),
  adminId: IdSchema.optional(),
  method: PaymentMethod.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
export type AdminTransactionQuery = z.infer<typeof AdminTransactionQuerySchema>;

export const DebtSchema = z.object({
  id: IdSchema,
  source: DebtSource,
  status: DebtStatus,
  originalAmount: MoneySchema,
  outstandingAmount: MoneySchema,
  trainingId: IdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  settledAt: IsoDateTimeSchema.nullable(),
});
export type Debt = z.infer<typeof DebtSchema>;

/** Result of any money-moving operation: the main row plus automatic debt settlements. */
export const LedgerResultSchema = z.object({
  transaction: AdminTransactionSchema,
  settlements: z.array(AdminTransactionSchema),
  wallet: z.object({ balance: MoneySchema, debt: MoneySchema }),
});
export type LedgerResult = z.infer<typeof LedgerResultSchema>;

// ── Admin money operations (all require Idempotency-Key) ───────────────────

export const CashPaymentRequestSchema = z.object({
  amountMinor: PositiveAmountSchema,
  description: z.string().trim().max(200).optional(),
});
export type CashPaymentRequest = z.infer<typeof CashPaymentRequestSchema>;

export const AdjustmentRequestSchema = z.object({
  /** CREDIT adds to the wallet, DEBIT removes (never below zero), DEBT_WAIVER forgives debt. */
  kind: z.enum(['CREDIT', 'DEBIT', 'DEBT_WAIVER']),
  amountMinor: PositiveAmountSchema,
  reason: ReasonSchema,
});
export type AdjustmentRequest = z.infer<typeof AdjustmentRequestSchema>;

export const RefundRequestSchema = z
  .object({
    amountMinor: PositiveAmountSchema,
    method: z.enum(['CASH', 'STRIPE']),
    /** Required for STRIPE: the online top-up to refund to the original payment method. */
    paymentId: IdSchema.optional(),
    reason: ReasonSchema,
  })
  .refine((v) => v.method !== 'STRIPE' || v.paymentId !== undefined, {
    message: 'payment_required',
    path: ['paymentId'],
  });
export type RefundRequest = z.infer<typeof RefundRequestSchema>;

export const ReversalRequestSchema = z.object({ reason: ReasonSchema });
export type ReversalRequest = z.infer<typeof ReversalRequestSchema>;

export const ADMIN_WALLET_SORT_FIELDS = ['balance', 'debt', 'updatedAt'] as const;
export const AdminWalletQuerySchema = OffsetQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  hasDebt: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sort: sortQuerySchema(ADMIN_WALLET_SORT_FIELDS),
});
export type AdminWalletQuery = z.infer<typeof AdminWalletQuerySchema>;

export const AdminWalletSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  balance: MoneySchema,
  debt: MoneySchema,
  updatedAt: IsoDateTimeSchema,
});
export type AdminWallet = z.infer<typeof AdminWalletSchema>;

// ── Online top-ups (Stripe) ─────────────────────────────────────────────────

export const CreateTopUpRequestSchema = z.object({
  amountMinor: z.number().int().positive(),
  currency: CurrencySchema,
});
export type CreateTopUpRequest = z.infer<typeof CreateTopUpRequestSchema>;

export const TopUpIntentSchema = z.object({
  paymentId: IdSchema,
  /** For the Stripe PaymentSheet. The wallet is credited only after Stripe confirms via webhook. */
  clientSecret: z.string(),
  publishableKey: z.string(),
  amount: MoneySchema,
});
export type TopUpIntent = z.infer<typeof TopUpIntentSchema>;

export const PaymentSchema = z.object({
  id: IdSchema,
  status: PaymentStatus,
  amount: MoneySchema,
  refundedAmount: MoneySchema,
  methodType: z.string().nullable(),
  failureCode: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  succeededAt: IsoDateTimeSchema.nullable(),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const AdminPaymentQuerySchema = OffsetQuerySchema.extend({
  status: PaymentStatus.optional(),
  userId: IdSchema.optional(),
});

export const AdminPaymentSchema = PaymentSchema.extend({
  userId: IdSchema,
  providerPaymentId: z.string().nullable(),
});
export type AdminPayment = z.infer<typeof AdminPaymentSchema>;
