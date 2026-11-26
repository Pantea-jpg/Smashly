import type {
  CashByAdmin,
  Dashboard,
  DebtAging,
  FinancialSummary,
  PeriodQuery,
  RevenuePoint,
} from '@tw/contracts';
import { DEFAULT_CURRENCY } from '@tw/money';
import type { PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import { money, TRANSACTION_INCLUDE, toAdminTransaction } from '../wallets/mappers';
import type { ReconciliationService } from './reconciliation.service';

/** Business timezone for calendar periods (months, weeks, days). */
export const REPORT_TIMEZONE = 'Europe/Amsterdam';
const MAX_PERIOD_DAYS = 3 * 366;

interface Period {
  from: Date;
  to: Date;
}

/** Postgres SUM/COUNT return bigint; amounts here stay far below 2^53. */
function num(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('Aggregate exceeds safe integer range');
  return n;
}

const eur = (amountMinor: number | bigint | null) => money(num(amountMinor), DEFAULT_CURRENCY);

export class ReportsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly reconciliation: ReconciliationService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Defaults to the current calendar month (Amsterdam) up to now. */
  async resolvePeriod(query: PeriodQuery): Promise<Period> {
    const now = this.now();
    const to = query.to ? new Date(query.to) : now;
    let from: Date;
    if (query.from) {
      from = new Date(query.from);
    } else {
      const rows = await this.prisma.$queryRaw<{ start: Date }[]>`
        SELECT (date_trunc('month', (${now}::timestamptz AT TIME ZONE ${REPORT_TIMEZONE}))
                AT TIME ZONE ${REPORT_TIMEZONE}) AS start`;
      from = rows[0]!.start;
    }
    if (from >= to) throw AppError.validation({ from: 'after_to' }, '`from` must be before `to`');
    if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * 86_400_000) {
      throw AppError.validation({ from: 'too_long' }, 'Period is too long (max 3 years)');
    }
    return { from, to };
  }

  private sumByType(type: string, period: Period) {
    return this.prisma.$queryRaw<{ total: bigint | null }[]>`
      SELECT SUM(amount_minor) AS total FROM wallet_transactions
       WHERE type = ${type}::"TransactionType" AND created_at >= ${period.from} AND created_at < ${period.to}`;
  }

  async dashboard(query: PeriodQuery): Promise<Dashboard> {
    const period = await this.resolvePeriod(query);
    const now = this.now();
    const [
      totalUsers,
      activeUsers,
      pendingUsers,
      upcomingTrainings,
      awaitingFinalization,
      reviewPayments,
      walletTotals,
      online,
      cash,
      revenue,
      recent,
      lastReport,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: 'USER', deletedAt: null } }),
      this.prisma.user.count({ where: { role: 'USER', deletedAt: null, status: 'ACTIVE' } }),
      this.prisma.user.count({
        where: { role: 'USER', deletedAt: null, status: 'PENDING_APPROVAL' },
      }),
      this.prisma.training.count({
        where: { status: 'SCHEDULED', deletedAt: null, startsAt: { gt: now } },
      }),
      this.prisma.training.count({
        where: {
          status: 'SCHEDULED',
          deletedAt: null,
          endsAt: { lt: now },
          attendanceFinalizedAt: null,
        },
      }),
      this.prisma.payment.count({ where: { status: 'REQUIRES_REVIEW' } }),
      this.prisma.wallet.aggregate({ _sum: { balanceMinor: true, debtMinor: true } }),
      this.sumByType('ONLINE_TOP_UP', period),
      this.sumByType('CASH_TOP_UP', period),
      this.prisma.trainingCharge.aggregate({
        where: { status: 'ACTIVE', createdAt: { gte: period.from, lt: period.to } },
        _sum: { unitPriceMinor: true },
      }),
      this.prisma.walletTransaction.findMany({
        include: TRANSACTION_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { sequence: 'desc' }],
        take: 10,
      }),
      this.reconciliation.lastReport(),
    ]);

    return {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      users: { total: totalUsers, active: activeUsers, pendingApproval: pendingUsers },
      upcomingTrainings,
      totalWalletBalances: eur(walletTotals._sum.balanceMinor),
      outstandingDebt: eur(walletTotals._sum.debtMinor),
      onlineTopUps: eur(online[0]?.total ?? 0),
      cashPayments: eur(cash[0]?.total ?? 0),
      trainingRevenue: eur(revenue._sum.unitPriceMinor),
      needsAttention: {
        paymentsRequiringReview: reviewPayments,
        trainingsAwaitingFinalization: awaitingFinalization,
        reconciliationIssues: lastReport ? lastReport.issues.length : null,
      },
      recentTransactions: recent.map(toAdminTransaction),
    };
  }

  /**
   * D20: "charged" = what attended trainings billed (accrual, incl. unpaid debt);
   * "collected" = what was actually paid towards those same charges; top-ups are wallet
   * funding (a liability), not revenue.
   */
  async summary(query: PeriodQuery): Promise<FinancialSummary> {
    const period = await this.resolvePeriod(query);
    const [online, cash, refunds, totals, charges, debtCreated] = await Promise.all([
      this.sumByType('ONLINE_TOP_UP', period),
      this.sumByType('CASH_TOP_UP', period),
      this.sumByType('REFUND', period),
      this.prisma.$queryRaw<
        {
          credit_adj: bigint | null;
          settled: bigint | null;
          waived: bigint | null;
          rev_count: bigint;
          rev_amount: bigint | null;
        }[]
      >`
        SELECT SUM(amount_minor) FILTER (WHERE type = 'ADJUSTMENT' AND wallet_delta_minor > 0) AS credit_adj,
               SUM(amount_minor) FILTER (WHERE type = 'DEBT_PAYMENT') AS settled,
               SUM(-debt_delta_minor) FILTER (WHERE type = 'ADJUSTMENT' AND debt_delta_minor < 0) AS waived,
               COUNT(*) FILTER (WHERE type = 'REVERSAL') AS rev_count,
               SUM(amount_minor) FILTER (WHERE type = 'REVERSAL') AS rev_amount
          FROM wallet_transactions
         WHERE created_at >= ${period.from} AND created_at < ${period.to}`,
      this.prisma.$queryRaw<
        {
          charged: bigint | null;
          paid_at_charge: bigint | null;
          paid_later: bigint | null;
          outstanding: bigint | null;
        }[]
      >`
        WITH c AS (
          SELECT id, unit_price_minor, paid_from_wallet_minor FROM training_charges
           WHERE status = 'ACTIVE' AND created_at >= ${period.from} AND created_at < ${period.to}
        )
        SELECT (SELECT SUM(unit_price_minor) FROM c) AS charged,
               (SELECT SUM(paid_from_wallet_minor) FROM c) AS paid_at_charge,
               (SELECT SUM(s.amount_minor) FROM debts d
                  JOIN debt_settlements s ON s.debt_id = d.id
                  JOIN wallet_transactions t ON t.id = s.transaction_id AND t.type = 'DEBT_PAYMENT'
                 WHERE d.training_charge_id IN (SELECT id FROM c)) AS paid_later,
               (SELECT SUM(d.outstanding_amount_minor) FROM debts d
                 WHERE d.status = 'OPEN' AND d.training_charge_id IN (SELECT id FROM c)) AS outstanding`,
      this.prisma.debt.aggregate({
        where: { createdAt: { gte: period.from, lt: period.to } },
        _sum: { originalAmountMinor: true },
      }),
    ]);
    const t = totals[0]!;
    const c = charges[0]!;
    return {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      topUps: {
        online: eur(online[0]?.total ?? 0),
        cash: eur(cash[0]?.total ?? 0),
        adjustmentsCredit: eur(t.credit_adj),
      },
      refunds: eur(refunds[0]?.total ?? 0),
      trainingRevenue: {
        charged: eur(c.charged),
        collected: eur(num(c.paid_at_charge) + num(c.paid_later)),
        outstanding: eur(c.outstanding),
      },
      debt: {
        created: eur(debtCreated._sum.originalAmountMinor),
        settled: eur(t.settled),
        waived: eur(t.waived),
      },
      reversals: { count: num(t.rev_count), amount: eur(t.rev_amount) },
    };
  }

  async revenue(
    query: PeriodQuery & { groupBy: 'day' | 'week' | 'month' },
  ): Promise<RevenuePoint[]> {
    const period = await this.resolvePeriod(query);
    const rows = await this.prisma.$queryRaw<
      {
        bucket: string;
        charged: bigint | null;
        online: bigint | null;
        cash: bigint | null;
        refunds: bigint | null;
      }[]
    >`
      WITH ledger AS (
        SELECT date_trunc(${query.groupBy}, created_at AT TIME ZONE ${REPORT_TIMEZONE}) AS bucket,
               SUM(amount_minor) FILTER (WHERE type = 'ONLINE_TOP_UP') AS online,
               SUM(amount_minor) FILTER (WHERE type = 'CASH_TOP_UP') AS cash,
               SUM(amount_minor) FILTER (WHERE type = 'REFUND') AS refunds
          FROM wallet_transactions
         WHERE created_at >= ${period.from} AND created_at < ${period.to}
         GROUP BY 1
      ), charges AS (
        SELECT date_trunc(${query.groupBy}, created_at AT TIME ZONE ${REPORT_TIMEZONE}) AS bucket,
               SUM(unit_price_minor) AS charged
          FROM training_charges
         WHERE status = 'ACTIVE' AND created_at >= ${period.from} AND created_at < ${period.to}
         GROUP BY 1
      )
      SELECT to_char(COALESCE(l.bucket, c.bucket), 'YYYY-MM-DD') AS bucket,
             c.charged, l.online, l.cash, l.refunds
        FROM ledger l FULL OUTER JOIN charges c ON c.bucket = l.bucket
       ORDER BY 1`;
    return rows.map((r) => ({
      // Formatted by Postgres in Amsterdam local time, so the server's timezone cannot shift it.
      period: query.groupBy === 'month' ? r.bucket.slice(0, 7) : r.bucket,
      charged: eur(r.charged),
      onlineTopUps: eur(r.online),
      cashTopUps: eur(r.cash),
      refunds: eur(r.refunds),
    }));
  }

  async debtAging(): Promise<DebtAging> {
    const asOf = this.now();
    const [buckets, users] = await Promise.all([
      this.prisma.$queryRaw<
        { label: '0-30' | '31-60' | '61+'; amount: bigint | null; count: bigint }[]
      >`
        SELECT CASE WHEN created_at >= ${asOf}::timestamptz - interval '30 days' THEN '0-30'
                    WHEN created_at >= ${asOf}::timestamptz - interval '60 days' THEN '31-60'
                    ELSE '61+' END AS label,
               SUM(outstanding_amount_minor) AS amount, COUNT(*) AS count
          FROM debts WHERE status = 'OPEN'
         GROUP BY 1`,
      this.prisma.$queryRaw<
        {
          user_id: string;
          email: string;
          first_name: string | null;
          last_name: string | null;
          outstanding: bigint;
          oldest: Date;
        }[]
      >`
        SELECT d.user_id::text AS user_id, u.email, p.first_name, p.last_name,
               SUM(d.outstanding_amount_minor) AS outstanding, MIN(d.created_at) AS oldest
          FROM debts d JOIN users u ON u.id = d.user_id LEFT JOIN user_profiles p ON p.user_id = d.user_id
         WHERE d.status = 'OPEN'
         GROUP BY d.user_id, u.email, p.first_name, p.last_name
         ORDER BY outstanding DESC
         LIMIT 500`,
    ]);
    const labels = ['0-30', '31-60', '61+'] as const;
    return {
      asOf: asOf.toISOString(),
      total: eur(buckets.reduce((s, b) => s + num(b.amount), 0)),
      buckets: labels.map((label) => {
        const b = buckets.find((x) => x.label === label);
        return { label, amount: eur(b?.amount ?? 0), count: num(b?.count ?? 0) };
      }),
      users: users.map((u) => ({
        userId: u.user_id,
        email: u.email,
        firstName: u.first_name ?? '',
        lastName: u.last_name ?? '',
        outstanding: eur(u.outstanding),
        oldestDebtAt: u.oldest.toISOString(),
      })),
    };
  }

  /** Cash collected per admin: what each admin should hand over (cash-drawer reconciliation). */
  async cashByAdmin(query: PeriodQuery): Promise<CashByAdmin> {
    const period = await this.resolvePeriod(query);
    const rows = await this.prisma.$queryRaw<
      {
        admin_id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
        count: bigint;
        total: bigint;
      }[]
    >`
      SELECT t.created_by_admin_id::text AS admin_id, u.email, p.first_name, p.last_name,
             COUNT(*) AS count, SUM(t.amount_minor) AS total
        FROM wallet_transactions t
        JOIN users u ON u.id = t.created_by_admin_id
        LEFT JOIN user_profiles p ON p.user_id = u.id
       WHERE t.type = 'CASH_TOP_UP' AND t.created_at >= ${period.from} AND t.created_at < ${period.to}
       GROUP BY 1, u.email, p.first_name, p.last_name
       ORDER BY total DESC`;
    return {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      admins: rows.map((r) => ({
        adminId: r.admin_id,
        email: r.email,
        firstName: r.first_name ?? '',
        lastName: r.last_name ?? '',
        count: num(r.count),
        total: eur(r.total),
      })),
    };
  }

  /** Raw ledger for the accountant (CSV). */
  async ledgerExport(query: PeriodQuery) {
    const period = await this.resolvePeriod(query);
    return this.prisma.walletTransaction.findMany({
      where: { createdAt: { gte: period.from, lt: period.to } },
      include: { user: { select: { email: true } } },
      orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }],
      take: 100_000,
    });
  }
}
