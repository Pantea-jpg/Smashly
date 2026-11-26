import { randomUUID } from 'node:crypto';
import type {
  LedgerResult,
  NotificationType,
  PaymentMethod,
  PriceSource,
  TransactionType,
} from '@tw/contracts';
import { DEFAULT_CURRENCY } from '@tw/money';
import { writeAudit } from '../../core/audit/audit';
import type { AuditContext } from '../../core/context/request-context';
import { Prisma, type PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { SettingsService } from '../admin/settings.service';
import { notifyUsers } from '../notifications/notify';
import { emitRealtime, walletChanged } from '../realtime/realtime';
import {
  allocateDebtSettlement,
  applyDelta,
  chargeReversalDelta,
  creditDelta,
  debitWithShortfall,
  type Delta,
  debtPaymentDelta,
  debtWaiverDelta,
  grossAmount,
  strictDebitDelta,
  trainingCharge,
} from './domain/ledger-math';
import { TRANSACTION_INCLUDE, type TransactionRow, toAdminTransaction, money } from './mappers';

type Tx = Prisma.TransactionClient;

/** D21: at most one low-balance notification per member per week. */
const LOW_BALANCE_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

/** A wallet row locked FOR UPDATE for the duration of the transaction; mutated in memory. */
interface LockedWallet {
  id: string;
  userId: string;
  currency: string;
  balanceMinor: number;
  debtMinor: number;
  sequence: number;
}

interface EntryInput {
  type: TransactionType;
  delta: Delta;
  amountMinor: number;
  paymentMethod: PaymentMethod;
  description: string;
  idempotencyKey: string;
  groupId: string;
  reason?: string | null;
  trainingId?: string | null;
  trainingChargeId?: string | null;
  paymentId?: string | null;
  createdByAdminId?: string | null;
  reversesTransactionId?: string | null;
}

interface Posted {
  main: TransactionRow;
  settlements: TransactionRow[];
  wallet: LockedWallet;
}

const TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 10_000,
  timeout: 30_000,
} as const;

/**
 * THE ONLY CODE THAT MOVES MONEY. Every operation, in one database transaction:
 *   1. locks the wallet row (SELECT ... FOR UPDATE) — concurrent operations queue up
 *   2. returns the earlier result if the idempotency key was already used (replay-safe)
 *   3. computes deltas with the pure ledger math and appends immutable ledger rows
 *      (gap-free per-wallet sequence, before/after balance and debt)
 *   4. settles open debts oldest-first after any credit (D16)
 *   5. updates the cached wallet totals, writes audit + in-app notification rows
 * Database CHECK constraints and append-only triggers back every rule up.
 */
export class LedgerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
  ) {}

  // ── Operations ──────────────────────────────────────────────────────────

  /** A user hands an admin cash (§11). */
  creditCash(
    input: {
      userId: string;
      amountMinor: number;
      description?: string | undefined;
      adminId: string;
      idempotencyKey: string;
    },
    ctx: AuditContext,
  ): Promise<LedgerResult> {
    return this.run(undefined, async (tx) => {
      const wallet = await this.lockWallet(tx, input.userId);
      const replay = await this.replay(tx, wallet, `cash:${input.adminId}:${input.idempotencyKey}`);
      if (replay) return replay;
      await this.assertBelowMaxBalance(tx, wallet, input.amountMinor);

      const groupId = randomUUID();
      const main = await this.post(tx, wallet, {
        type: 'CASH_TOP_UP',
        delta: creditDelta(input.amountMinor),
        amountMinor: input.amountMinor,
        paymentMethod: 'CASH',
        description: input.description?.trim() || 'Cash payment',
        idempotencyKey: `cash:${input.adminId}:${input.idempotencyKey}`,
        groupId,
        createdByAdminId: input.adminId,
      });
      const settlements = await this.settleDebts(tx, wallet, main);
      await this.finish(tx, wallet, ctx, main, 'wallet.cash_top_up', {
        type: 'CASH_PAYMENT_RECORDED',
        params: { amountMinor: input.amountMinor, currency: wallet.currency },
      });
      return this.result({ main, settlements, wallet });
    });
  }

  /** Called only from verified Stripe events (webhook or the payment sweeper). */
  async creditOnlineTopUp(
    tx: Tx,
    payment: {
      id: string;
      userId: string;
      amountMinor: number;
      currency: string;
      providerPaymentId: string;
    },
    ctx: AuditContext,
  ): Promise<LedgerResult> {
    const wallet = await this.lockWallet(tx, payment.userId, payment.currency);
    const key = `stripe_pi:${payment.providerPaymentId}`;
    const replay = await this.replay(tx, wallet, key);
    if (replay) return replay;

    // The money is already captured: the balance cap was checked when the intent was created.
    const main = await this.post(tx, wallet, {
      type: 'ONLINE_TOP_UP',
      delta: creditDelta(payment.amountMinor),
      amountMinor: payment.amountMinor,
      paymentMethod: 'STRIPE',
      description: 'Online top-up',
      idempotencyKey: key,
      groupId: randomUUID(),
      paymentId: payment.id,
    });
    const settlements = await this.settleDebts(tx, wallet, main);
    await this.finish(tx, wallet, ctx, main, 'wallet.online_top_up', {
      type: 'TOP_UP_SUCCEEDED',
      params: { amountMinor: payment.amountMinor, currency: wallet.currency },
    });
    return this.result({ main, settlements, wallet });
  }

  /**
   * Charges one PRESENT participant (Phase 6 attendance finalization calls this inside its
   * own transaction). Creates the TrainingCharge with the price snapshot, the ledger row and,
   * for any shortfall, a Debt. A free training (price 0) creates the charge but no ledger row.
   */
  async chargeTraining(
    tx: Tx,
    input: {
      trainingId: string;
      trainingTitle: string;
      userId: string;
      attendanceId: string;
      unitPriceMinor: number;
      priceSource: PriceSource;
      currency: string;
    },
    ctx: AuditContext,
  ): Promise<{ chargeId: string; result: LedgerResult | null }> {
    const wallet = await this.lockWallet(tx, input.userId, input.currency);
    const previous = await tx.trainingCharge.count({
      where: { trainingId: input.trainingId, userId: input.userId },
    });
    const key = `charge:${input.trainingId}:${input.userId}:${previous + 1}`;

    const split = trainingCharge(wallet, input.unitPriceMinor);
    // The partial unique index makes a second ACTIVE charge for this pair impossible.
    const charge = await tx.trainingCharge.create({
      data: {
        trainingId: input.trainingId,
        userId: input.userId,
        walletId: wallet.id,
        attendanceId: input.attendanceId,
        unitPriceMinor: input.unitPriceMinor,
        priceSource: input.priceSource,
        currency: wallet.currency,
        paidFromWalletMinor: split.paidFromWalletMinor,
        shortfallMinor: split.shortfallMinor,
      },
    });
    if (input.unitPriceMinor === 0) {
      await this.persistWallet(tx, wallet);
      return { chargeId: charge.id, result: null };
    }

    const main = await this.post(tx, wallet, {
      type: 'TRAINING_PAYMENT',
      delta: split.delta,
      amountMinor: input.unitPriceMinor,
      paymentMethod: 'WALLET',
      description: input.trainingTitle,
      idempotencyKey: key,
      groupId: randomUUID(),
      trainingId: input.trainingId,
      trainingChargeId: charge.id,
    });
    if (split.shortfallMinor > 0) {
      await tx.debt.create({
        data: {
          userId: input.userId,
          walletId: wallet.id,
          source: 'TRAINING_CHARGE',
          sourceTransactionId: main.id,
          trainingChargeId: charge.id,
          originalAmountMinor: split.shortfallMinor,
          outstandingAmountMinor: split.shortfallMinor,
          currency: wallet.currency,
        },
      });
    }
    await this.finish(tx, wallet, ctx, main, 'wallet.training_charged', {
      type: 'TRAINING_CHARGED',
      params: {
        trainingId: input.trainingId,
        trainingTitle: input.trainingTitle,
        amountMinor: input.unitPriceMinor,
        shortfallMinor: split.shortfallMinor,
        currency: wallet.currency,
      },
    });
    return { chargeId: charge.id, result: this.result({ main, settlements: [], wallet }) };
  }

  /** Admin correction: CREDIT, DEBIT (never below zero) or DEBT_WAIVER, always with a reason (D19). */
  adjust(
    input: {
      userId: string;
      kind: 'CREDIT' | 'DEBIT' | 'DEBT_WAIVER';
      amountMinor: number;
      reason: string;
      adminId: string;
      idempotencyKey: string;
    },
    ctx: AuditContext,
  ): Promise<LedgerResult> {
    return this.run(undefined, async (tx) => {
      const wallet = await this.lockWallet(tx, input.userId);
      const key = `adjust:${input.adminId}:${input.idempotencyKey}`;
      const replay = await this.replay(tx, wallet, key);
      if (replay) return replay;

      let delta: Delta;
      if (input.kind === 'CREDIT') {
        delta = creditDelta(input.amountMinor);
      } else if (input.kind === 'DEBIT') {
        if (input.amountMinor > wallet.balanceMinor) {
          throw new AppError('INSUFFICIENT_BALANCE', 'Debit exceeds the wallet balance');
        }
        delta = strictDebitDelta(wallet, input.amountMinor);
      } else {
        if (input.amountMinor > wallet.debtMinor) {
          throw new AppError('AMOUNT_OUT_OF_RANGE', 'Waiver exceeds the outstanding debt');
        }
        delta = debtWaiverDelta(wallet, input.amountMinor);
      }

      const main = await this.post(tx, wallet, {
        type: 'ADJUSTMENT',
        delta,
        amountMinor: input.amountMinor,
        paymentMethod: 'SYSTEM',
        description:
          input.kind === 'CREDIT'
            ? 'Credit adjustment'
            : input.kind === 'DEBIT'
              ? 'Debit adjustment'
              : 'Debt waived',
        reason: input.reason,
        idempotencyKey: key,
        groupId: randomUUID(),
        createdByAdminId: input.adminId,
      });
      if (input.kind === 'DEBT_WAIVER') {
        await this.reduceDebtsOldestFirst(tx, wallet.id, main.id, input.amountMinor, 'CANCELLED');
      }
      const settlements = input.kind === 'CREDIT' ? await this.settleDebts(tx, wallet, main) : [];
      await this.finish(tx, wallet, ctx, main, `wallet.adjustment_${input.kind.toLowerCase()}`);
      return this.result({ main, settlements, wallet });
    });
  }

  /** Admin pays unused balance back in cash (D17). Card refunds go through PaymentsService. */
  refundCash(
    input: {
      userId: string;
      amountMinor: number;
      reason: string;
      adminId: string;
      idempotencyKey: string;
    },
    ctx: AuditContext,
  ): Promise<LedgerResult> {
    return this.run(undefined, async (tx) => {
      const wallet = await this.lockWallet(tx, input.userId);
      const key = `refund:${input.adminId}:${input.idempotencyKey}`;
      const replay = await this.replay(tx, wallet, key);
      if (replay) return replay;
      if (input.amountMinor > wallet.balanceMinor) {
        throw new AppError('INSUFFICIENT_BALANCE', 'Refund exceeds the wallet balance');
      }
      const main = await this.post(tx, wallet, {
        type: 'REFUND',
        delta: strictDebitDelta(wallet, input.amountMinor),
        amountMinor: input.amountMinor,
        paymentMethod: 'CASH',
        description: 'Cash refund',
        reason: input.reason,
        idempotencyKey: key,
        groupId: randomUUID(),
        createdByAdminId: input.adminId,
      });
      await this.finish(tx, wallet, ctx, main, 'wallet.refund_cash');
      return this.result({ main, settlements: [], wallet });
    });
  }

  /**
   * Money that left through Stripe (card refund, chargeback). It cannot be refused: what the
   * wallet does not cover becomes debt (D18). Idempotent on the Stripe object id.
   */
  async debitExternal(
    tx: Tx,
    input: {
      userId: string;
      currency: string;
      amountMinor: number;
      idempotencyKey: string;
      paymentId: string;
      description: string;
      reason: string;
      adminId?: string | null;
    },
    ctx: AuditContext,
  ): Promise<{ result: LedgerResult; created: boolean }> {
    const wallet = await this.lockWallet(tx, input.userId, input.currency);
    const replay = await this.replay(tx, wallet, input.idempotencyKey);
    if (replay) return { result: replay, created: false };

    const split = debitWithShortfall(wallet, input.amountMinor);
    const main = await this.post(tx, wallet, {
      type: 'REFUND',
      delta: split.delta,
      amountMinor: input.amountMinor,
      paymentMethod: 'STRIPE',
      description: input.description,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      groupId: randomUUID(),
      paymentId: input.paymentId,
      createdByAdminId: input.adminId ?? null,
    });
    if (split.shortfallMinor > 0)
      await this.createShortfallDebt(tx, wallet, main.id, split.shortfallMinor);
    await this.finish(tx, wallet, ctx, main, 'wallet.refund_stripe');
    return { result: this.result({ main, settlements: [], wallet }), created: true };
  }

  /**
   * Money Stripe gave back (dispute won, card refund failed): credit it, settling debt first.
   * Idempotent on the Stripe object id; `created` is false for a replay, so callers only
   * update their own records once.
   */
  async creditSystem(
    tx: Tx,
    input: {
      userId: string;
      currency: string;
      amountMinor: number;
      idempotencyKey: string;
      paymentId: string;
      description: string;
      reason: string;
    },
    ctx: AuditContext,
  ): Promise<{ result: LedgerResult; created: boolean }> {
    const wallet = await this.lockWallet(tx, input.userId, input.currency);
    const replay = await this.replay(tx, wallet, input.idempotencyKey);
    if (replay) return { result: replay, created: false };
    const main = await this.post(tx, wallet, {
      type: 'ADJUSTMENT',
      delta: creditDelta(input.amountMinor),
      amountMinor: input.amountMinor,
      paymentMethod: 'SYSTEM',
      description: input.description,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      groupId: randomUUID(),
      paymentId: input.paymentId,
    });
    const settlements = await this.settleDebts(tx, wallet, main);
    await this.finish(tx, wallet, ctx, main, 'wallet.stripe_funds_returned');
    return { result: this.result({ main, settlements, wallet }), created: true };
  }

  /**
   * Corrects a wrong entry with a REVERSAL row (financial records are never edited).
   * Reversible here: cash top-ups, credit/debit adjustments and cash refunds.
   * Training charges are reversed through attendance corrections (Phase 6) via
   * `reverseTrainingCharge`; online top-ups are undone by refunding them through Stripe.
   */
  reverse(
    input: { transactionId: string; reason: string; adminId: string },
    ctx: AuditContext,
  ): Promise<LedgerResult> {
    return this.run(undefined, async (tx) => {
      const original = await tx.walletTransaction.findUnique({
        where: { id: input.transactionId },
        include: TRANSACTION_INCLUDE,
      });
      if (!original) throw AppError.notFound('Transaction');
      const wallet = await this.lockWallet(tx, original.userId, original.currency);
      if (await this.isReversed(tx, original.id)) {
        throw new AppError('ALREADY_REVERSED', 'This transaction has already been reversed');
      }

      const reversible =
        original.type === 'CASH_TOP_UP' ||
        (original.type === 'ADJUSTMENT' &&
          original.debtDeltaMinor === 0 &&
          original.paymentId === null) ||
        (original.type === 'REFUND' && original.paymentMethod === 'CASH');
      if (!reversible) {
        throw new AppError(
          'NOT_REVERSIBLE',
          original.type === 'TRAINING_PAYMENT'
            ? 'Correct the attendance instead; the charge is reversed from there'
            : original.type === 'ONLINE_TOP_UP'
              ? 'Refund online top-ups to the card instead'
              : 'This kind of transaction cannot be reversed',
        );
      }

      const base = {
        type: 'REVERSAL' as const,
        paymentMethod: 'SYSTEM' as const,
        description: `Reversal: ${original.description}`,
        reason: input.reason,
        idempotencyKey: `reversal:${original.id}`,
        groupId: randomUUID(),
        createdByAdminId: input.adminId,
        reversesTransactionId: original.id,
        trainingId: original.trainingId,
        paymentId: original.paymentId,
      };

      let main: TransactionRow;
      let settlements: TransactionRow[] = [];
      if (original.walletDeltaMinor > 0) {
        // Undo a credit; if it was already spent, the remainder becomes debt (D18).
        const split = debitWithShortfall(wallet, original.walletDeltaMinor);
        main = await this.post(tx, wallet, {
          ...base,
          delta: split.delta,
          amountMinor: original.walletDeltaMinor,
        });
        if (split.shortfallMinor > 0)
          await this.createShortfallDebt(tx, wallet, main.id, split.shortfallMinor);
      } else {
        // Undo a debit: give the money back, which may settle open debts.
        const amount = -original.walletDeltaMinor;
        main = await this.post(tx, wallet, {
          ...base,
          delta: creditDelta(amount),
          amountMinor: amount,
        });
        settlements = await this.settleDebts(tx, wallet, main);
      }
      await this.finish(tx, wallet, ctx, main, 'wallet.reversal', undefined, {
        reversedTransactionId: original.id,
        reason: input.reason,
      });
      return this.result({ main, settlements, wallet });
    });
  }

  /**
   * Reverses a training charge: returns what the user actually paid towards it (at charge
   * time + later debt payments; waived parts were never paid) and cancels what is still owed.
   */
  async reverseTrainingCharge(
    tx: Tx,
    input: { chargeId: string; reason: string; adminId: string | null },
    ctx: AuditContext,
  ): Promise<LedgerResult | null> {
    const charge = await tx.trainingCharge.findUnique({ where: { id: input.chargeId } });
    if (!charge) throw AppError.notFound('Charge');
    const wallet = await this.lockWallet(tx, charge.userId, charge.currency);
    const fresh = await tx.trainingCharge.findUniqueOrThrow({
      where: { id: charge.id },
      include: {
        debt: {
          include: { settlements: { include: { transaction: { select: { type: true } } } } },
        },
        transactions: {
          where: { type: 'TRAINING_PAYMENT' },
          select: { id: true, description: true },
        },
      },
    });
    if (fresh.status === 'REVERSED')
      throw new AppError('ALREADY_REVERSED', 'Charge already reversed');

    const now = new Date();
    await tx.trainingCharge.update({
      where: { id: charge.id },
      data: { status: 'REVERSED', reversedAt: now },
    });
    const original = fresh.transactions[0];
    if (!original) {
      // Free training: nothing was moved.
      await this.persistWallet(tx, wallet);
      return null;
    }

    const debt = fresh.debt;
    const settledByPayments =
      debt?.settlements
        .filter((s) => s.transaction.type === 'DEBT_PAYMENT')
        .reduce((sum, s) => sum + s.amountMinor, 0) ?? 0;
    const outstanding = debt?.outstandingAmountMinor ?? 0;
    const delta = chargeReversalDelta({
      paidAtChargeMinor: fresh.paidFromWalletMinor,
      settledByPaymentsMinor: settledByPayments,
      outstandingMinor: outstanding,
    });
    if (delta.walletDeltaMinor === 0 && delta.debtDeltaMinor === 0) {
      // Never paid and the whole debt was already waived: nothing to give back or cancel.
      await this.persistWallet(tx, wallet);
      return null;
    }

    const main = await this.post(tx, wallet, {
      type: 'REVERSAL',
      delta,
      amountMinor: grossAmount(delta),
      paymentMethod: 'SYSTEM',
      description: `Reversal: ${original.description}`,
      reason: input.reason,
      idempotencyKey: `reversal:${original.id}`,
      groupId: randomUUID(),
      createdByAdminId: input.adminId,
      reversesTransactionId: original.id,
      trainingId: fresh.trainingId,
      trainingChargeId: fresh.id,
    });
    if (debt) {
      if (outstanding > 0) {
        await tx.debtSettlement.create({
          data: { debtId: debt.id, transactionId: main.id, amountMinor: outstanding },
        });
      }
      await tx.debt.update({
        where: { id: debt.id },
        data: { outstandingAmountMinor: 0, status: 'CANCELLED', cancelledAt: now },
      });
    }
    const settlements = await this.settleDebts(tx, wallet, main);
    await this.finish(tx, wallet, ctx, main, 'wallet.charge_reversed', undefined, {
      chargeId: charge.id,
    });
    return this.result({ main, settlements, wallet });
  }

  /** Runs `fn` inside the caller's transaction, or a new one. Exposed for orchestrating services. */
  run<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : this.prisma.$transaction(fn, TX_OPTIONS);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async lockWallet(
    tx: Tx,
    userId: string,
    currency: string = DEFAULT_CURRENCY,
  ): Promise<LockedWallet> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        user_id: string;
        currency: string;
        balance_minor: number;
        debt_minor: number;
        sequence: number;
      }[]
    >`SELECT id, user_id, currency, balance_minor, debt_minor, sequence
        FROM wallets WHERE user_id = ${userId}::uuid AND currency = ${currency}
        FOR UPDATE`;
    const row = rows[0];
    if (!row) throw AppError.notFound('Wallet');
    return {
      id: row.id,
      userId: row.user_id,
      currency: row.currency,
      balanceMinor: row.balance_minor,
      debtMinor: row.debt_minor,
      sequence: row.sequence,
    };
  }

  /** Returns the stored result for an idempotency key, or null when it is new. */
  private async replay(
    tx: Tx,
    wallet: LockedWallet,
    idempotencyKey: string,
  ): Promise<LedgerResult | null> {
    const existing = await tx.walletTransaction.findUnique({
      where: { idempotencyKey },
      include: TRANSACTION_INCLUDE,
    });
    if (!existing) return null;
    if (existing.walletId !== wallet.id) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key belongs to another wallet');
    }
    const settlements = await tx.walletTransaction.findMany({
      where: { groupId: existing.groupId, type: 'DEBT_PAYMENT' },
      include: TRANSACTION_INCLUDE,
      orderBy: { sequence: 'asc' },
    });
    const current = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    return {
      transaction: toAdminTransaction(existing),
      settlements: settlements.map(toAdminTransaction),
      wallet: {
        balance: money(current.balanceMinor, current.currency),
        debt: money(current.debtMinor, current.currency),
      },
    };
  }

  private async isReversed(tx: Tx, transactionId: string): Promise<boolean> {
    return (
      (await tx.walletTransaction.count({ where: { reversesTransactionId: transactionId } })) > 0
    );
  }

  /** Appends one immutable ledger row and advances the in-memory wallet state. */
  private async post(tx: Tx, wallet: LockedWallet, entry: EntryInput): Promise<TransactionRow> {
    const before = { balanceMinor: wallet.balanceMinor, debtMinor: wallet.debtMinor };
    const after = applyDelta(before, entry.delta);
    const sequence = wallet.sequence + 1;
    const row = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        userId: wallet.userId,
        sequence,
        type: entry.type,
        amountMinor: entry.amountMinor,
        walletDeltaMinor: entry.delta.walletDeltaMinor || 0,
        debtDeltaMinor: entry.delta.debtDeltaMinor || 0,
        balanceBeforeMinor: before.balanceMinor,
        balanceAfterMinor: after.balanceMinor,
        debtBeforeMinor: before.debtMinor,
        debtAfterMinor: after.debtMinor,
        currency: wallet.currency,
        paymentMethod: entry.paymentMethod,
        description: entry.description.slice(0, 200),
        reason: entry.reason ?? null,
        idempotencyKey: entry.idempotencyKey,
        groupId: entry.groupId,
        trainingId: entry.trainingId ?? null,
        trainingChargeId: entry.trainingChargeId ?? null,
        paymentId: entry.paymentId ?? null,
        createdByAdminId: entry.createdByAdminId ?? null,
        reversesTransactionId: entry.reversesTransactionId ?? null,
      },
      include: TRANSACTION_INCLUDE,
    });
    wallet.sequence = sequence;
    wallet.balanceMinor = after.balanceMinor;
    wallet.debtMinor = after.debtMinor;
    return row;
  }

  /** D16: pay open debts oldest first from the available balance, one DEBT_PAYMENT per debt. */
  private async settleDebts(
    tx: Tx,
    wallet: LockedWallet,
    credit: TransactionRow,
  ): Promise<TransactionRow[]> {
    if (wallet.balanceMinor === 0 || wallet.debtMinor === 0) return [];
    const open = await tx.$queryRaw<
      { id: string; outstanding: number; training_id: string | null }[]
    >`
      SELECT d.id, d.outstanding_amount_minor AS outstanding, tc.training_id
        FROM debts d LEFT JOIN training_charges tc ON tc.id = d.training_charge_id
       WHERE d.wallet_id = ${wallet.id}::uuid AND d.status = 'OPEN'
       ORDER BY d.created_at, d.id
       FOR UPDATE OF d`;
    const allocations = allocateDebtSettlement(
      wallet.balanceMinor,
      open.map((d) => ({ id: d.id, outstandingMinor: d.outstanding })),
    );

    const rows: TransactionRow[] = [];
    for (const allocation of allocations) {
      const debt = open.find((d) => d.id === allocation.debtId)!;
      const row = await this.post(tx, wallet, {
        type: 'DEBT_PAYMENT',
        delta: debtPaymentDelta(allocation.amountMinor),
        amountMinor: allocation.amountMinor,
        paymentMethod: 'WALLET',
        description: 'Outstanding balance paid',
        idempotencyKey: `debt_payment:${credit.id}:${debt.id}`,
        groupId: credit.groupId,
        trainingId: debt.training_id,
      });
      await tx.debtSettlement.create({
        data: { debtId: debt.id, transactionId: row.id, amountMinor: allocation.amountMinor },
      });
      const remaining = debt.outstanding - allocation.amountMinor;
      await tx.debt.update({
        where: { id: debt.id },
        data: {
          outstandingAmountMinor: remaining,
          ...(remaining === 0 ? { status: 'SETTLED', settledAt: new Date() } : {}),
        },
      });
      rows.push(row);
    }
    return rows;
  }

  /** Waivers reduce open debts oldest first; a fully waived debt is CANCELLED. */
  private async reduceDebtsOldestFirst(
    tx: Tx,
    walletId: string,
    transactionId: string,
    amountMinor: number,
    closedStatus: 'CANCELLED',
  ): Promise<void> {
    const open = await tx.$queryRaw<{ id: string; outstanding: number }[]>`
      SELECT id, outstanding_amount_minor AS outstanding FROM debts
       WHERE wallet_id = ${walletId}::uuid AND status = 'OPEN'
       ORDER BY created_at, id FOR UPDATE`;
    for (const allocation of allocateDebtSettlement(
      amountMinor,
      open.map((d) => ({ id: d.id, outstandingMinor: d.outstanding })),
    )) {
      const debt = open.find((d) => d.id === allocation.debtId)!;
      const remaining = debt.outstanding - allocation.amountMinor;
      await tx.debtSettlement.create({
        data: { debtId: debt.id, transactionId, amountMinor: allocation.amountMinor },
      });
      await tx.debt.update({
        where: { id: debt.id },
        data: {
          outstandingAmountMinor: remaining,
          ...(remaining === 0 ? { status: closedStatus, cancelledAt: new Date() } : {}),
        },
      });
    }
  }

  private async createShortfallDebt(
    tx: Tx,
    wallet: LockedWallet,
    sourceTransactionId: string,
    amountMinor: number,
  ) {
    await tx.debt.create({
      data: {
        userId: wallet.userId,
        walletId: wallet.id,
        source: 'TOP_UP_REVERSAL',
        sourceTransactionId,
        originalAmountMinor: amountMinor,
        outstandingAmountMinor: amountMinor,
        currency: wallet.currency,
      },
    });
  }

  private async assertBelowMaxBalance(
    tx: Tx,
    wallet: LockedWallet,
    creditMinor: number,
  ): Promise<void> {
    const max = await this.settings.get('wallet.maxBalanceMinor', tx);
    const total = wallet.balanceMinor + creditMinor;
    const afterSettlement = total - Math.min(wallet.debtMinor, total);
    if (afterSettlement > max) {
      throw new AppError('BALANCE_LIMIT_EXCEEDED', 'This would exceed the maximum wallet balance', {
        maxBalanceMinor: max,
      });
    }
  }

  private async persistWallet(tx: Tx, wallet: LockedWallet): Promise<void> {
    await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        balanceMinor: wallet.balanceMinor,
        debtMinor: wallet.debtMinor,
        sequence: wallet.sequence,
      },
    });
  }

  private async finish(
    tx: Tx,
    wallet: LockedWallet,
    ctx: AuditContext,
    main: TransactionRow,
    action: string,
    notification?: { type: NotificationType; params: Record<string, unknown> },
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.persistWallet(tx, wallet);
    await writeAudit(tx, ctx, {
      action,
      entityType: 'WalletTransaction',
      entityId: main.id,
      after: {
        userId: wallet.userId,
        type: main.type,
        amountMinor: main.amountMinor,
        balanceAfterMinor: wallet.balanceMinor,
        debtAfterMinor: wallet.debtMinor,
        ...extra,
      },
    });
    if (notification) {
      // In-app + push, deduplicated per ledger entry.
      await notifyUsers(tx, {
        userIds: [wallet.userId],
        type: notification.type,
        category: 'PAYMENTS',
        params: { ...notification.params, transactionId: main.id },
        dedupeKey: `ledger:${main.idempotencyKey}`,
      });
    }
    await this.checkLowBalance(tx, wallet, main);
    await emitRealtime(tx, walletChanged(wallet.userId));
  }

  /**
   * D21: one LOW_BALANCE notification when an operation takes the balance from at or above
   * the threshold to below it, at most once per 7 days per member.
   */
  private async checkLowBalance(tx: Tx, wallet: LockedWallet, main: TransactionRow) {
    const threshold = await this.settings.get('wallet.lowBalanceThresholdMinor', tx);
    if (threshold <= 0) return;
    if (!(main.balanceBeforeMinor >= threshold && wallet.balanceMinor < threshold)) return;
    const recent = await tx.notification.findFirst({
      where: {
        userId: wallet.userId,
        type: 'LOW_BALANCE',
        createdAt: { gt: new Date(Date.now() - LOW_BALANCE_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) return;
    await notifyUsers(tx, {
      userIds: [wallet.userId],
      type: 'LOW_BALANCE',
      category: 'REMINDERS',
      params: { amountMinor: wallet.balanceMinor, currency: wallet.currency },
      dedupeKey: `low-balance:${main.id}`,
    });
  }

  private result(posted: Posted): LedgerResult {
    return {
      transaction: toAdminTransaction(posted.main),
      settlements: posted.settlements.map(toAdminTransaction),
      wallet: {
        balance: money(posted.wallet.balanceMinor, posted.wallet.currency),
        debt: money(posted.wallet.debtMinor, posted.wallet.currency),
      },
    };
  }
}
