import type { ReconciliationReport } from '@tw/contracts';
import type { PrismaClient } from '../../core/db/prisma';

type Issue = ReconciliationReport['issues'][number];

const LAST_REPORT_KEY = 'system.reconciliation.lastReport';

/**
 * Independent proof that the books add up. Each check recomputes a figure from the immutable
 * ledger and compares it with what the system stores. Mismatches are REPORTED, never
 * auto-corrected: a human posts an ADJUSTMENT with a reason.
 */
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** @param options.persist false for read-only checks (e.g. verifying a restored backup). */
  async run(options: { persist?: boolean } = {}): Promise<ReconciliationReport> {
    const issues: Issue[] = [];
    const add = (check: string, entityType: string, rows: { id: string; detail: string }[]) => {
      for (const row of rows)
        issues.push({ check, entityType, entityId: row.id, detail: row.detail });
    };

    // 1. Cached wallet totals and sequence equal the ledger.
    add(
      'wallet_totals_match_ledger',
      'Wallet',
      await this.prisma.$queryRaw`
        SELECT w.id::text AS id,
               format('cached balance %s / debt %s / sequence %s; ledger balance %s / debt %s / rows %s / max seq %s',
                      w.balance_minor, w.debt_minor, w.sequence,
                      COALESCE(SUM(t.wallet_delta_minor), 0), COALESCE(SUM(t.debt_delta_minor), 0),
                      COUNT(t.id), COALESCE(MAX(t.sequence), 0)) AS detail
          FROM wallets w
          LEFT JOIN wallet_transactions t ON t.wallet_id = w.id
         GROUP BY w.id
        HAVING w.balance_minor <> COALESCE(SUM(t.wallet_delta_minor), 0)
            OR w.debt_minor <> COALESCE(SUM(t.debt_delta_minor), 0)
            OR w.sequence <> COUNT(t.id)
            OR w.sequence <> COALESCE(MAX(t.sequence), 0)`,
    );

    // 2. Each row starts where the previous one ended (no gaps, no edits).
    add(
      'ledger_chain_continuous',
      'WalletTransaction',
      await this.prisma.$queryRaw`
        SELECT id::text AS id, format('wallet %s seq %s breaks the chain', wallet_id, sequence) AS detail
          FROM (
            SELECT id, wallet_id, sequence, balance_before_minor, debt_before_minor,
                   LAG(balance_after_minor) OVER w AS prev_balance,
                   LAG(debt_after_minor) OVER w AS prev_debt,
                   LAG(sequence) OVER w AS prev_seq
              FROM wallet_transactions
            WINDOW w AS (PARTITION BY wallet_id ORDER BY sequence)
          ) x
         WHERE (prev_seq IS NULL AND (sequence <> 1 OR balance_before_minor <> 0 OR debt_before_minor <> 0))
            OR (prev_seq IS NOT NULL AND (sequence <> prev_seq + 1
                OR balance_before_minor <> prev_balance OR debt_before_minor <> prev_debt))`,
    );

    // 3. A wallet's debt equals the sum of its open debts.
    add(
      'wallet_debt_matches_open_debts',
      'Wallet',
      await this.prisma.$queryRaw`
        SELECT w.id::text AS id,
               format('wallet debt %s, open debts %s', w.debt_minor, COALESCE(SUM(d.outstanding_amount_minor), 0)) AS detail
          FROM wallets w
          LEFT JOIN debts d ON d.wallet_id = w.id AND d.status = 'OPEN'
         GROUP BY w.id
        HAVING w.debt_minor <> COALESCE(SUM(d.outstanding_amount_minor), 0)`,
    );

    // 4. Every debt: original = settled/cancelled parts + outstanding.
    add(
      'debt_bookkeeping',
      'Debt',
      await this.prisma.$queryRaw`
        SELECT d.id::text AS id,
               format('original %s <> settlements %s + outstanding %s',
                      d.original_amount_minor, COALESCE(SUM(s.amount_minor), 0), d.outstanding_amount_minor) AS detail
          FROM debts d
          LEFT JOIN debt_settlements s ON s.debt_id = d.id
         GROUP BY d.id
        HAVING d.original_amount_minor <> COALESCE(SUM(s.amount_minor), 0) + d.outstanding_amount_minor`,
    );

    // 5. A paid top-up was credited exactly once with its exact amount; unpaid ones never.
    add(
      'payment_credited_once',
      'Payment',
      await this.prisma.$queryRaw`
        SELECT p.id::text AS id,
               format('status %s, amount %s, credits %s totalling %s',
                      p.status, p.amount_minor, COUNT(t.id), COALESCE(SUM(t.amount_minor), 0)) AS detail
          FROM payments p
          LEFT JOIN wallet_transactions t ON t.payment_id = p.id AND t.type = 'ONLINE_TOP_UP'
         GROUP BY p.id
        HAVING (p.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED')
                AND (COUNT(t.id) <> 1 OR COALESCE(SUM(t.amount_minor), 0) <> p.amount_minor))
            OR (p.status NOT IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED') AND COUNT(t.id) <> 0)`,
    );

    // 6. A charge matches its ledger row (price snapshot, wallet part, debt part).
    add(
      'charge_matches_ledger',
      'TrainingCharge',
      await this.prisma.$queryRaw`
        SELECT tc.id::text AS id,
               format('price %s paid %s shortfall %s; ledger rows %s', tc.unit_price_minor,
                      tc.paid_from_wallet_minor, tc.shortfall_minor, COUNT(t.id)) AS detail
          FROM training_charges tc
          LEFT JOIN wallet_transactions t ON t.training_charge_id = tc.id AND t.type = 'TRAINING_PAYMENT'
         WHERE tc.unit_price_minor > 0
         GROUP BY tc.id
        HAVING COUNT(t.id) <> 1
            OR MAX(t.amount_minor) <> tc.unit_price_minor
            OR MAX(t.wallet_delta_minor) <> -tc.paid_from_wallet_minor
            OR MAX(t.debt_delta_minor) <> tc.shortfall_minor`,
    );

    // 7. A reversed charge has its REVERSAL row; an active one does not.
    add(
      'charge_reversal_consistent',
      'TrainingCharge',
      await this.prisma.$queryRaw`
        SELECT tc.id::text AS id, format('status %s but reversal rows %s', tc.status, COUNT(r.id)) AS detail
          FROM training_charges tc
          JOIN wallet_transactions t ON t.training_charge_id = tc.id AND t.type = 'TRAINING_PAYMENT'
          LEFT JOIN wallet_transactions r ON r.reverses_transaction_id = t.id
         GROUP BY tc.id
        HAVING (tc.status = 'ACTIVE' AND COUNT(r.id) <> 0)
            OR (tc.status = 'REVERSED' AND COUNT(r.id) <> CASE
                  -- No reversal row is posted when nothing was paid and the debt was fully waived.
                  WHEN tc.paid_from_wallet_minor = 0 AND NOT EXISTS (
                         SELECT 1 FROM debts d
                           JOIN debt_settlements ds ON ds.debt_id = d.id
                           JOIN wallet_transactions st ON st.id = ds.transaction_id
                          WHERE d.training_charge_id = tc.id AND st.type <> 'ADJUSTMENT')
                  THEN 0 ELSE 1 END)`,
    );

    const walletsChecked = await this.prisma.wallet.count();
    const report: ReconciliationReport = {
      ranAt: this.now().toISOString(),
      walletsChecked,
      issues,
    };
    if (options.persist !== false) {
      await this.prisma.appSetting.upsert({
        where: { key: LAST_REPORT_KEY },
        create: { key: LAST_REPORT_KEY, value: report },
        update: { value: report },
      });
    }
    return report;
  }

  async lastReport(): Promise<ReconciliationReport | null> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: LAST_REPORT_KEY } });
    return (row?.value as ReconciliationReport | undefined) ?? null;
  }
}
