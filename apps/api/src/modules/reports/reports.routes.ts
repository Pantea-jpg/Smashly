import {
  CashByAdminSchema,
  DashboardSchema,
  DebtAgingSchema,
  FinancialSummarySchema,
  PeriodQuerySchema,
  ReconciliationReportSchema,
  RevenuePointSchema,
  RevenueQuerySchema,
} from '@tw/contracts';
import { money as moneyValue, toMajorString } from '@tw/money';
import { z } from 'zod';
import { writeAudit } from '../../core/audit/audit';
import { auditContextOf } from '../../core/context/request-context';
import type { PrismaClient } from '../../core/db/prisma';
import type { ApiRouter } from '../../core/http/api-router';
import { currencyOf } from '../wallets/mappers';
import type { ReconciliationService } from './reconciliation.service';
import type { ReportsService } from './reports.service';

/** Minor units → "12.50" for spreadsheets (display only; all arithmetic stays in integers). */
const major = (minor: number, currency = 'EUR') =>
  toMajorString(moneyValue(minor, currencyOf(currency)));

export function registerReportRoutes(
  api: ApiRouter,
  deps: { prisma: PrismaClient; reports: ReportsService; reconciliation: ReconciliationService },
): void {
  const tags: [string] = ['Admin · Reports'];
  const { reports } = deps;

  api.route(
    {
      method: 'get',
      path: '/dashboard',
      summary: 'Operational and financial KPIs (default period: this month)',
      tags,
      auth: 'admin',
      request: { query: PeriodQuerySchema },
      response: { status: 200, schema: DashboardSchema },
    },
    ({ query }) => reports.dashboard(query),
  );

  api.route(
    {
      method: 'get',
      path: '/reports/summary',
      summary: 'Financial summary: top-ups, refunds, training revenue charged vs collected, debt',
      tags,
      auth: 'admin',
      request: { query: PeriodQuerySchema },
      response: { status: 200, schema: FinancialSummarySchema },
    },
    ({ query }) => reports.summary(query),
  );

  api.route(
    {
      method: 'get',
      path: '/reports/revenue',
      summary: 'Revenue and top-ups per day, week or month (Amsterdam calendar)',
      tags,
      auth: 'admin',
      request: { query: RevenueQuerySchema },
      response: { status: 200, schema: z.array(RevenuePointSchema) },
    },
    ({ query }) => reports.revenue(query),
  );

  api.route(
    {
      method: 'get',
      path: '/reports/debts',
      summary: 'Outstanding debt by age and by user',
      tags,
      auth: 'admin',
      response: { status: 200, schema: DebtAgingSchema },
    },
    () => reports.debtAging(),
  );

  api.route(
    {
      method: 'get',
      path: '/reports/cash',
      summary: 'Cash collected per admin',
      tags,
      auth: 'admin',
      request: { query: PeriodQuerySchema },
      response: { status: 200, schema: CashByAdminSchema },
    },
    ({ query }) => reports.cashByAdmin(query),
  );

  // ── CSV exports ──────────────────────────────────────────────────────────

  api.csv(
    {
      method: 'get',
      path: '/reports/revenue.csv',
      summary: 'Revenue report as CSV',
      tags,
      auth: 'admin',
      request: { query: RevenueQuerySchema },
    },
    async ({ query }) => {
      const points = await reports.revenue(query);
      return {
        filename: `revenue-${query.groupBy}.csv`,
        header: [
          'period',
          'currency',
          'training_charged',
          'online_top_ups',
          'cash_top_ups',
          'refunds',
        ],
        rows: points.map((p) => [
          p.period,
          p.charged.currency,
          major(p.charged.amountMinor),
          major(p.onlineTopUps.amountMinor),
          major(p.cashTopUps.amountMinor),
          major(p.refunds.amountMinor),
        ]),
      };
    },
  );

  api.csv(
    {
      method: 'get',
      path: '/reports/debts.csv',
      summary: 'Outstanding debt per user as CSV',
      tags,
      auth: 'admin',
    },
    async () => {
      const aging = await reports.debtAging();
      return {
        filename: 'outstanding-debt.csv',
        header: [
          'user_id',
          'email',
          'first_name',
          'last_name',
          'currency',
          'outstanding',
          'oldest_debt_at',
        ],
        rows: aging.users.map((u) => [
          u.userId,
          u.email,
          u.firstName,
          u.lastName,
          u.outstanding.currency,
          major(u.outstanding.amountMinor),
          u.oldestDebtAt,
        ]),
      };
    },
  );

  api.csv(
    {
      method: 'get',
      path: '/reports/cash.csv',
      summary: 'Cash collected per admin as CSV',
      tags,
      auth: 'admin',
      request: { query: PeriodQuerySchema },
    },
    async ({ query }) => {
      const cash = await reports.cashByAdmin(query);
      return {
        filename: 'cash-by-admin.csv',
        header: ['admin_id', 'email', 'first_name', 'last_name', 'payments', 'currency', 'total'],
        rows: cash.admins.map((a) => [
          a.adminId,
          a.email,
          a.firstName,
          a.lastName,
          a.count,
          a.total.currency,
          major(a.total.amountMinor),
        ]),
      };
    },
  );

  api.csv(
    {
      method: 'get',
      path: '/reports/ledger.csv',
      summary: 'Every ledger entry in the period as CSV (for the accountant)',
      tags,
      auth: 'admin',
      request: { query: PeriodQuerySchema },
    },
    async ({ query }) => {
      const rows = await reports.ledgerExport(query);
      return {
        filename: 'ledger.csv',
        header: [
          'created_at',
          'transaction_id',
          'user_id',
          'email',
          'sequence',
          'type',
          'method',
          'currency',
          'amount',
          'wallet_delta',
          'debt_delta',
          'balance_after',
          'debt_after',
          'description',
          'reason',
          'training_id',
          'payment_id',
          'admin_id',
          'reverses_transaction_id',
        ],
        rows: rows.map((t) => [
          t.createdAt.toISOString(),
          t.id,
          t.userId,
          t.user.email,
          t.sequence,
          t.type,
          t.paymentMethod,
          t.currency,
          major(t.amountMinor, t.currency),
          major(t.walletDeltaMinor, t.currency),
          major(t.debtDeltaMinor, t.currency),
          major(t.balanceAfterMinor, t.currency),
          major(t.debtAfterMinor, t.currency),
          t.description,
          t.reason,
          t.trainingId,
          t.paymentId,
          t.createdByAdminId,
          t.reversesTransactionId,
        ]),
      };
    },
  );

  // ── Reconciliation ───────────────────────────────────────────────────────

  api.route(
    {
      method: 'post',
      path: '/reconciliation/run',
      summary: 'Recompute every wallet from the ledger and report mismatches',
      description: 'Also runs nightly in the worker. Never corrects anything automatically.',
      tags,
      auth: 'admin',
      response: { status: 200, schema: ReconciliationReportSchema },
    },
    async ({ req }) => {
      const report = await deps.reconciliation.run();
      await writeAudit(deps.prisma, auditContextOf(req), {
        action: 'reconciliation.run',
        entityType: 'System',
        after: { walletsChecked: report.walletsChecked, issues: report.issues.length },
      });
      return report;
    },
  );

  api.route(
    {
      method: 'get',
      path: '/reconciliation/last',
      summary: 'The most recent reconciliation report',
      tags,
      auth: 'admin',
      response: { status: 200, schema: ReconciliationReportSchema.nullable() },
    },
    () => deps.reconciliation.lastReport(),
  );
}
