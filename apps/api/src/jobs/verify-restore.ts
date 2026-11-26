import type { PrismaClient } from '../core/db/prisma';
import { ReconciliationService } from '../modules/reports/reconciliation.service';

export interface RestoreReport {
  ok: boolean;
  /** Most recent ledger and audit entries: how far the restored copy reaches in time. */
  latest: { ledgerAt: string | null; auditAt: string | null; signInAt: string | null };
  counts: Record<string, number>;
  migrations: { applied: number; failed: string[]; missing: string[] };
  protections: { missing: string[] };
  reconciliation: { walletsChecked: number; issues: number; sample: string[] };
  problems: string[];
}

/** The same connection string, with every transaction read-only (enforced by PostgreSQL). */
export function readOnlyUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-c default_transaction_read_only=on');
  return url.toString();
}

/** Triggers that make financial records append-only (must survive any restore). */
const REQUIRED_TRIGGERS = [
  'wallet_transactions_append_only',
  'debt_settlements_append_only',
  'audit_logs_append_only',
  'payments_no_delete',
  'wallets_no_delete',
];

/**
 * Read-only check of a restored database (backup restore drill, docs/10-runbooks.md):
 *   - every migration the release expects is applied and none failed;
 *   - the append-only protections on financial tables are present;
 *   - the books add up (full reconciliation, without saving its report);
 *   - row counts and the latest entries, to compare with production at the restore point.
 */
export async function verifyRestore(
  prisma: PrismaClient,
  expectedMigrations: string[],
): Promise<RestoreReport> {
  const problems: string[] = [];

  const migrationRows = await prisma.$queryRaw<
    { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
  >`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
  const applied = new Set(
    migrationRows.filter((m) => m.finished_at && !m.rolled_back_at).map((m) => m.migration_name),
  );
  const failed = migrationRows
    .filter((m) => !m.finished_at && !m.rolled_back_at)
    .map((m) => m.migration_name);
  const missing = expectedMigrations.filter((m) => !applied.has(m));
  if (failed.length) problems.push(`failed migrations: ${failed.join(', ')}`);
  if (missing.length) problems.push(`migrations not applied: ${missing.join(', ')}`);

  const triggers = new Set(
    (
      await prisma.$queryRaw<{ tgname: string }[]>`
        SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`
    ).map((t) => t.tgname),
  );
  const missingTriggers = REQUIRED_TRIGGERS.filter((t) => !triggers.has(t));
  if (missingTriggers.length) problems.push(`missing protections: ${missingTriggers.join(', ')}`);

  const [users, wallets, transactions, payments, trainings, auditLogs] = await Promise.all([
    prisma.user.count(),
    prisma.wallet.count(),
    prisma.walletTransaction.count(),
    prisma.payment.count(),
    prisma.training.count(),
    prisma.auditLog.count(),
  ]);
  const [ledger, audit, signIn] = await Promise.all([
    prisma.walletTransaction.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.user.findFirst({
      where: { lastLoginAt: { not: null } },
      orderBy: { lastLoginAt: 'desc' },
      select: { lastLoginAt: true },
    }),
  ]);

  const reconciliation = await new ReconciliationService(prisma).run({ persist: false });
  if (reconciliation.issues.length) {
    problems.push(`reconciliation found ${String(reconciliation.issues.length)} issue(s)`);
  }

  return {
    ok: problems.length === 0,
    latest: {
      ledgerAt: ledger?.createdAt.toISOString() ?? null,
      auditAt: audit?.createdAt.toISOString() ?? null,
      signInAt: signIn?.lastLoginAt?.toISOString() ?? null,
    },
    counts: { users, wallets, transactions, payments, trainings, auditLogs },
    migrations: { applied: applied.size, failed, missing },
    protections: { missing: missingTriggers },
    reconciliation: {
      walletsChecked: reconciliation.walletsChecked,
      issues: reconciliation.issues.length,
      sample: reconciliation.issues.slice(0, 10).map((i) => `${i.check}: ${i.detail}`),
    },
    problems,
  };
}
