import type { AdminTransaction, Debt, Payment, Transaction } from '@tw/contracts';
import { DEFAULT_CURRENCY, isCurrencyCode, type CurrencyCode } from '@tw/money';
import type { Prisma } from '../../core/db/prisma';

export function currencyOf(code: string): CurrencyCode {
  return isCurrencyCode(code) ? code : DEFAULT_CURRENCY;
}

/** Normalises -0 so JSON never shows it. */
function minor(value: number): number {
  return value === 0 ? 0 : value;
}

export function money(amountMinor: number, currency: string) {
  return { amountMinor: minor(amountMinor), currency: currencyOf(currency) };
}

export const TRANSACTION_INCLUDE = {
  reversedBy: { select: { id: true } },
} satisfies Prisma.WalletTransactionInclude;

export type TransactionRow = Prisma.WalletTransactionGetPayload<{
  include: typeof TRANSACTION_INCLUDE;
}>;

export function toTransaction(row: TransactionRow): Transaction {
  const c = row.currency;
  return {
    id: row.id,
    type: row.type,
    status: row.reversedBy ? 'REVERSED' : 'POSTED',
    amount: money(row.amountMinor, c),
    walletDelta: money(row.walletDeltaMinor, c),
    debtDelta: money(row.debtDeltaMinor, c),
    balanceAfter: money(row.balanceAfterMinor, c),
    debtAfter: money(row.debtAfterMinor, c),
    paymentMethod: row.paymentMethod,
    description: row.description,
    reason: row.reason,
    trainingId: row.trainingId,
    paymentId: row.paymentId,
    reversesTransactionId: row.reversesTransactionId,
    reversedByTransactionId: row.reversedBy?.id ?? null,
    groupId: row.groupId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAdminTransaction(row: TransactionRow): AdminTransaction {
  return {
    ...toTransaction(row),
    userId: row.userId,
    sequence: row.sequence,
    balanceBefore: money(row.balanceBeforeMinor, row.currency),
    debtBefore: money(row.debtBeforeMinor, row.currency),
    createdByAdminId: row.createdByAdminId,
  };
}

export function toDebt(
  row: Prisma.DebtGetPayload<{ include: { trainingCharge: { select: { trainingId: true } } } }>,
): Debt {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    originalAmount: money(row.originalAmountMinor, row.currency),
    outstandingAmount: money(row.outstandingAmountMinor, row.currency),
    trainingId: row.trainingCharge?.trainingId ?? null,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}

export function toPayment(row: Prisma.PaymentGetPayload<object>): Payment {
  return {
    id: row.id,
    status: row.status,
    amount: money(row.amountMinor, row.currency),
    refundedAmount: money(row.refundedAmountMinor, row.currency),
    methodType: row.methodType,
    failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(),
    succeededAt: row.succeededAt?.toISOString() ?? null,
  };
}
