/**
 * Pure ledger arithmetic (integer minor units, no I/O). Every money-moving operation is
 * expressed as a delta on (balance, debt); the ledger service persists the result.
 *
 * Invariants enforced here AND by database CHECK constraints:
 *   balance >= 0, debt >= 0, every amount is a safe integer.
 */

export interface WalletState {
  readonly balanceMinor: number;
  readonly debtMinor: number;
}

export interface Delta {
  readonly walletDeltaMinor: number;
  readonly debtDeltaMinor: number;
}

export class LedgerInvariantError extends Error {
  override readonly name = 'LedgerInvariantError';
}

function assertAmount(value: number, name: string, { allowZero = false } = {}): void {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new LedgerInvariantError(
      `${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer, got ${value}`,
    );
  }
}

/** Applies a delta; throws instead of ever producing a negative balance or debt. */
export function applyDelta(state: WalletState, delta: Delta): WalletState {
  const next = {
    balanceMinor: state.balanceMinor + delta.walletDeltaMinor,
    debtMinor: state.debtMinor + delta.debtDeltaMinor,
  };
  if (!Number.isSafeInteger(next.balanceMinor) || !Number.isSafeInteger(next.debtMinor)) {
    throw new LedgerInvariantError('Non-integer wallet state');
  }
  if (next.balanceMinor < 0) throw new LedgerInvariantError('Balance would become negative');
  if (next.debtMinor < 0) throw new LedgerInvariantError('Debt would become negative');
  return next;
}

/** Cash, online top-up or credit adjustment. */
export function creditDelta(amountMinor: number): Delta {
  assertAmount(amountMinor, 'Credit amount');
  return { walletDeltaMinor: amountMinor, debtDeltaMinor: 0 };
}

export interface TrainingChargeSplit {
  paidFromWalletMinor: number;
  shortfallMinor: number;
  delta: Delta;
}

/**
 * Charging a training (only for PRESENT): pay what the wallet holds, the rest becomes debt.
 * €10 fee, €6 balance → €6 from the wallet, €4 debt.
 */
export function trainingCharge(state: WalletState, priceMinor: number): TrainingChargeSplit {
  assertAmount(priceMinor, 'Training price', { allowZero: true });
  const paidFromWalletMinor = Math.min(state.balanceMinor, priceMinor);
  const shortfallMinor = priceMinor - paidFromWalletMinor;
  return {
    paidFromWalletMinor,
    shortfallMinor,
    delta: { walletDeltaMinor: -paidFromWalletMinor, debtDeltaMinor: shortfallMinor },
  };
}

export interface OpenDebt {
  readonly id: string;
  readonly outstandingMinor: number;
}

export interface Settlement {
  debtId: string;
  amountMinor: number;
}

/**
 * Debt allocation policy (D16): after every credit, the available balance pays open debts
 * oldest first (caller passes them sorted by creation). Partial settlement is allowed.
 */
export function allocateDebtSettlement(
  availableMinor: number,
  openDebtsOldestFirst: readonly OpenDebt[],
): Settlement[] {
  assertAmount(availableMinor, 'Available balance', { allowZero: true });
  const settlements: Settlement[] = [];
  let remaining = availableMinor;
  for (const debt of openDebtsOldestFirst) {
    if (remaining === 0) break;
    assertAmount(debt.outstandingMinor, 'Debt outstanding');
    const amountMinor = Math.min(remaining, debt.outstandingMinor);
    settlements.push({ debtId: debt.id, amountMinor });
    remaining -= amountMinor;
  }
  return settlements;
}

/** One automatic debt payment: money leaves the wallet and reduces debt by the same amount. */
export function debtPaymentDelta(amountMinor: number): Delta {
  assertAmount(amountMinor, 'Debt payment');
  return { walletDeltaMinor: -amountMinor, debtDeltaMinor: -amountMinor };
}

/**
 * Money that leaves the system although the wallet may not cover it (Stripe refund made in
 * the dashboard, chargeback, reversing a cash top-up that was already spent): take what the
 * wallet holds, the remainder becomes debt (D18). The balance never goes negative.
 */
export function debitWithShortfall(state: WalletState, amountMinor: number): TrainingChargeSplit {
  // Same arithmetic as a training charge: pay what you can, owe the rest.
  assertAmount(amountMinor, 'Debit amount');
  return trainingCharge(state, amountMinor);
}

/** A debit that must be fully covered by the balance (admin refund, debit adjustment). */
export function strictDebitDelta(state: WalletState, amountMinor: number): Delta {
  assertAmount(amountMinor, 'Debit amount');
  if (amountMinor > state.balanceMinor) {
    throw new LedgerInvariantError('Insufficient balance');
  }
  return { walletDeltaMinor: -amountMinor, debtDeltaMinor: 0 };
}

/** Forgiving debt (admin waiver). Cannot exceed what is owed. */
export function debtWaiverDelta(state: WalletState, amountMinor: number): Delta {
  assertAmount(amountMinor, 'Waiver amount');
  if (amountMinor > state.debtMinor) throw new LedgerInvariantError('Waiver exceeds debt');
  return { walletDeltaMinor: 0, debtDeltaMinor: -amountMinor };
}

export interface ChargeHistory {
  /** What the wallet paid at the moment of charging. */
  paidAtChargeMinor: number;
  /** Later automatic debt payments towards this charge's debt (waivers excluded: never paid). */
  settledByPaymentsMinor: number;
  /** What is still owed on this charge. */
  outstandingMinor: number;
}

/**
 * Reversing a training charge (wrong attendance, cancelled training): return everything the
 * user actually paid towards it, and cancel what is still owed.
 */
export function chargeReversalDelta(history: ChargeHistory): Delta {
  assertAmount(history.paidAtChargeMinor, 'Paid at charge', { allowZero: true });
  assertAmount(history.settledByPaymentsMinor, 'Settled', { allowZero: true });
  assertAmount(history.outstandingMinor, 'Outstanding', { allowZero: true });
  return {
    walletDeltaMinor: history.paidAtChargeMinor + history.settledByPaymentsMinor,
    debtDeltaMinor: -history.outstandingMinor,
  };
}

/** The gross amount recorded for a row: total money moved in either column. */
export function grossAmount(delta: Delta): number {
  return Math.abs(delta.walletDeltaMinor) + Math.abs(delta.debtDeltaMinor);
}
