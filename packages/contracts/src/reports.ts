import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MoneySchema } from './common';
import { AdminTransactionSchema } from './wallet';

export const PeriodQuerySchema = z.object({
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
export type PeriodQuery = z.infer<typeof PeriodQuerySchema>;

const PeriodSchema = z.object({ from: IsoDateTimeSchema, to: IsoDateTimeSchema });

export const DashboardSchema = z.object({
  period: PeriodSchema,
  users: z.object({
    total: z.number().int(),
    active: z.number().int(),
    pendingApproval: z.number().int(),
  }),
  upcomingTrainings: z.number().int(),
  totalWalletBalances: MoneySchema,
  outstandingDebt: MoneySchema,
  onlineTopUps: MoneySchema,
  cashPayments: MoneySchema,
  trainingRevenue: MoneySchema,
  needsAttention: z.object({
    paymentsRequiringReview: z.number().int(),
    trainingsAwaitingFinalization: z.number().int(),
    reconciliationIssues: z.number().int().nullable(),
  }),
  recentTransactions: z.array(AdminTransactionSchema),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

/**
 * Revenue recognition (D20): "charged" is what trainings billed (accrual, incl. unpaid debt);
 * "collected" is what was actually paid towards those charges. Top-ups are wallet funding
 * (a liability), not revenue.
 */
export const FinancialSummarySchema = z.object({
  period: PeriodSchema,
  topUps: z.object({ online: MoneySchema, cash: MoneySchema, adjustmentsCredit: MoneySchema }),
  refunds: MoneySchema,
  trainingRevenue: z.object({
    charged: MoneySchema,
    collected: MoneySchema,
    outstanding: MoneySchema,
  }),
  debt: z.object({ created: MoneySchema, settled: MoneySchema, waived: MoneySchema }),
  reversals: z.object({ count: z.number().int(), amount: MoneySchema }),
});
export type FinancialSummary = z.infer<typeof FinancialSummarySchema>;

export const RevenueQuerySchema = PeriodQuerySchema.extend({
  groupBy: z.enum(['day', 'week', 'month']).default('month'),
});

export const RevenuePointSchema = z.object({
  period: z.string(),
  charged: MoneySchema,
  onlineTopUps: MoneySchema,
  cashTopUps: MoneySchema,
  refunds: MoneySchema,
});
export type RevenuePoint = z.infer<typeof RevenuePointSchema>;

export const DebtAgingSchema = z.object({
  asOf: IsoDateTimeSchema,
  total: MoneySchema,
  buckets: z.array(
    z.object({
      label: z.enum(['0-30', '31-60', '61+']),
      amount: MoneySchema,
      count: z.number().int(),
    }),
  ),
  users: z.array(
    z.object({
      userId: IdSchema,
      email: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      outstanding: MoneySchema,
      oldestDebtAt: IsoDateTimeSchema,
    }),
  ),
});
export type DebtAging = z.infer<typeof DebtAgingSchema>;

export const CashByAdminSchema = z.object({
  period: PeriodSchema,
  admins: z.array(
    z.object({
      adminId: IdSchema,
      email: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      count: z.number().int(),
      total: MoneySchema,
    }),
  ),
});
export type CashByAdmin = z.infer<typeof CashByAdminSchema>;

export const ReconciliationIssueSchema = z.object({
  check: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  detail: z.string(),
});

export const ReconciliationReportSchema = z.object({
  ranAt: IsoDateTimeSchema,
  walletsChecked: z.number().int(),
  issues: z.array(ReconciliationIssueSchema),
});
export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;
