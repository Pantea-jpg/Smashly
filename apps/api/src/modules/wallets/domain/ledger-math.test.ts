import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocateDebtSettlement,
  applyDelta,
  chargeReversalDelta,
  creditDelta,
  debitWithShortfall,
  debtPaymentDelta,
  debtWaiverDelta,
  LedgerInvariantError,
  strictDebitDelta,
  trainingCharge,
  type WalletState,
} from './ledger-math';

const EMPTY: WalletState = { balanceMinor: 0, debtMinor: 0 };
const amount = fc.integer({ min: 1, max: 100_000 });

describe('the specification example (€10 fee, €6 balance)', () => {
  it('takes €6 from the wallet and records €4 debt; a €50 top-up then settles it', () => {
    let wallet = applyDelta(EMPTY, creditDelta(600));
    const charge = trainingCharge(wallet, 1000);
    expect(charge).toMatchObject({ paidFromWalletMinor: 600, shortfallMinor: 400 });
    wallet = applyDelta(wallet, charge.delta);
    expect(wallet).toEqual({ balanceMinor: 0, debtMinor: 400 });

    wallet = applyDelta(wallet, creditDelta(5000));
    const settlements = allocateDebtSettlement(wallet.balanceMinor, [
      { id: 'd1', outstandingMinor: 400 },
    ]);
    expect(settlements).toEqual([{ debtId: 'd1', amountMinor: 400 }]);
    wallet = applyDelta(wallet, debtPaymentDelta(400));
    expect(wallet).toEqual({ balanceMinor: 4600, debtMinor: 0 });
  });
});

describe('trainingCharge', () => {
  it('charges fully from the wallet when it is enough', () => {
    expect(trainingCharge({ balanceMinor: 1500, debtMinor: 0 }, 1000)).toMatchObject({
      paidFromWalletMinor: 1000,
      shortfallMinor: 0,
    });
  });

  it('allows free trainings (price 0) without moving money', () => {
    expect(trainingCharge({ balanceMinor: 500, debtMinor: 0 }, 0).delta).toEqual({
      walletDeltaMinor: -0,
      debtDeltaMinor: 0,
    });
  });

  it.each([-1, 1.5, Number.NaN])('rejects price %s', (price) => {
    expect(() => trainingCharge(EMPTY, price)).toThrow(LedgerInvariantError);
  });

  it('property: paid + shortfall = price, and the wallet never goes negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (balance, price) => {
          const state = { balanceMinor: balance, debtMinor: 0 };
          const split = trainingCharge(state, price);
          expect(split.paidFromWalletMinor + split.shortfallMinor).toBe(price);
          const next = applyDelta(state, split.delta);
          expect(next.balanceMinor).toBeGreaterThanOrEqual(0);
          expect(next.balanceMinor === 0 || split.shortfallMinor === 0).toBe(true);
        },
      ),
    );
  });
});

describe('allocateDebtSettlement (FIFO)', () => {
  const debts = [
    { id: 'oldest', outstandingMinor: 300 },
    { id: 'middle', outstandingMinor: 500 },
    { id: 'newest', outstandingMinor: 200 },
  ];

  it('pays oldest first and allows partial settlement', () => {
    expect(allocateDebtSettlement(600, debts)).toEqual([
      { debtId: 'oldest', amountMinor: 300 },
      { debtId: 'middle', amountMinor: 300 },
    ]);
  });

  it('pays nothing with no balance and everything with enough', () => {
    expect(allocateDebtSettlement(0, debts)).toEqual([]);
    expect(allocateDebtSettlement(10_000, debts).reduce((s, x) => s + x.amountMinor, 0)).toBe(1000);
  });

  it('property: never pays more than available or owed, and respects order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000 }),
        fc.array(amount, { maxLength: 12 }),
        (available, outstanding) => {
          const open = outstanding.map((o, i) => ({ id: `d${i}`, outstandingMinor: o }));
          const result = allocateDebtSettlement(available, open);
          const paid = result.reduce((s, x) => s + x.amountMinor, 0);
          const owed = outstanding.reduce((s, x) => s + x, 0);
          expect(paid).toBe(Math.min(available, owed));
          // Only the last settled debt may be partial; all earlier ones are paid in full.
          result.slice(0, -1).forEach((s, i) => expect(s.amountMinor).toBe(outstanding[i]));
          result.forEach((s, i) => expect(s.debtId).toBe(`d${i}`));
        },
      ),
    );
  });
});

describe('debits', () => {
  it('debitWithShortfall turns an uncovered remainder into debt (D18)', () => {
    const split = debitWithShortfall({ balanceMinor: 200, debtMinor: 0 }, 500);
    expect(split.delta).toEqual({ walletDeltaMinor: -200, debtDeltaMinor: 300 });
  });

  it('strictDebitDelta refuses to overdraw', () => {
    expect(() => strictDebitDelta({ balanceMinor: 100, debtMinor: 0 }, 101)).toThrow(
      'Insufficient balance',
    );
    expect(strictDebitDelta({ balanceMinor: 100, debtMinor: 0 }, 100).walletDeltaMinor).toBe(-100);
  });

  it('debtWaiverDelta cannot forgive more than is owed', () => {
    expect(() => debtWaiverDelta({ balanceMinor: 0, debtMinor: 100 }, 101)).toThrow();
    expect(debtWaiverDelta({ balanceMinor: 0, debtMinor: 100 }, 100)).toEqual({
      walletDeltaMinor: 0,
      debtDeltaMinor: -100,
    });
  });

  it('applyDelta refuses negative results', () => {
    expect(() => applyDelta(EMPTY, { walletDeltaMinor: -1, debtDeltaMinor: 0 })).toThrow(
      'negative',
    );
    expect(() => applyDelta(EMPTY, { walletDeltaMinor: 0, debtDeltaMinor: -1 })).toThrow(
      'negative',
    );
  });
});

describe('chargeReversalDelta', () => {
  it('returns paid money and cancels open debt (before the debt was settled)', () => {
    expect(
      chargeReversalDelta({
        paidAtChargeMinor: 600,
        settledByPaymentsMinor: 0,
        outstandingMinor: 400,
      }),
    ).toEqual({
      walletDeltaMinor: 600,
      debtDeltaMinor: -400,
    });
  });

  it('returns the full price once the debt was paid off', () => {
    expect(
      chargeReversalDelta({
        paidAtChargeMinor: 600,
        settledByPaymentsMinor: 400,
        outstandingMinor: 0,
      }),
    ).toEqual({
      walletDeltaMinor: 1000,
      debtDeltaMinor: -0,
    });
  });
});

/**
 * Model-based property: a random sequence of operations, applied through the pure functions
 * the ledger uses, never breaks an invariant, and the per-debt bookkeeping always adds up.
 */
describe('random operation sequences', () => {
  type Op =
    | { kind: 'credit'; amount: number }
    | { kind: 'charge'; price: number }
    | { kind: 'waive'; amount: number }
    | { kind: 'debitShortfall'; amount: number }
    | { kind: 'reverseLastCharge' };

  const op: fc.Arbitrary<Op> = fc.oneof(
    amount.map((a) => ({ kind: 'credit' as const, amount: a })),
    fc.integer({ min: 0, max: 5000 }).map((p) => ({ kind: 'charge' as const, price: p })),
    amount.map((a) => ({ kind: 'waive' as const, amount: a })),
    amount.map((a) => ({ kind: 'debitShortfall' as const, amount: a })),
    fc.constant({ kind: 'reverseLastCharge' as const }),
  );

  it('keeps balance >= 0, debt >= 0, and debt = sum of open debts', () => {
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 60 }), (ops) => {
        let wallet: WalletState = EMPTY;
        const debts: { id: string; outstanding: number; settledByPayment: number }[] = [];
        const charges: { paid: number; debtIndex: number | null; reversed: boolean }[] = [];

        const settle = () => {
          const open = debts
            .filter((d) => d.outstanding > 0)
            .map((d) => ({ id: d.id, outstandingMinor: d.outstanding }));
          for (const s of allocateDebtSettlement(wallet.balanceMinor, open)) {
            wallet = applyDelta(wallet, debtPaymentDelta(s.amountMinor));
            const d = debts.find((x) => x.id === s.debtId)!;
            d.outstanding -= s.amountMinor;
            d.settledByPayment += s.amountMinor;
          }
        };

        for (const o of ops) {
          switch (o.kind) {
            case 'credit':
              wallet = applyDelta(wallet, creditDelta(o.amount));
              settle();
              break;
            case 'charge': {
              const split = trainingCharge(wallet, o.price);
              wallet = applyDelta(wallet, split.delta);
              let debtIndex: number | null = null;
              if (split.shortfallMinor > 0) {
                debts.push({
                  id: `d${debts.length}`,
                  outstanding: split.shortfallMinor,
                  settledByPayment: 0,
                });
                debtIndex = debts.length - 1;
              }
              charges.push({ paid: split.paidFromWalletMinor, debtIndex, reversed: false });
              break;
            }
            case 'waive': {
              const waive = Math.min(o.amount, wallet.debtMinor);
              if (waive === 0) break;
              wallet = applyDelta(wallet, debtWaiverDelta(wallet, waive));
              let left = waive;
              for (const d of debts) {
                const x = Math.min(left, d.outstanding);
                d.outstanding -= x;
                left -= x;
              }
              break;
            }
            case 'debitShortfall': {
              const split = debitWithShortfall(wallet, o.amount);
              wallet = applyDelta(wallet, split.delta);
              if (split.shortfallMinor > 0) {
                debts.push({
                  id: `d${debts.length}`,
                  outstanding: split.shortfallMinor,
                  settledByPayment: 0,
                });
              }
              break;
            }
            case 'reverseLastCharge': {
              const c = [...charges].reverse().find((x) => !x.reversed);
              if (!c) break;
              const d = c.debtIndex === null ? null : debts[c.debtIndex]!;
              wallet = applyDelta(
                wallet,
                chargeReversalDelta({
                  paidAtChargeMinor: c.paid,
                  settledByPaymentsMinor: d?.settledByPayment ?? 0,
                  outstandingMinor: d?.outstanding ?? 0,
                }),
              );
              if (d) d.outstanding = 0;
              c.reversed = true;
              settle();
              break;
            }
          }
          expect(wallet.balanceMinor).toBeGreaterThanOrEqual(0);
          expect(wallet.debtMinor).toBeGreaterThanOrEqual(0);
          expect(wallet.debtMinor).toBe(debts.reduce((s, d) => s + d.outstanding, 0));
          // After any credit-like step settles, money and debt never coexist.
          if (o.kind === 'credit' || o.kind === 'reverseLastCharge') {
            expect(wallet.balanceMinor === 0 || wallet.debtMinor === 0).toBe(true);
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});
