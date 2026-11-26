/**
 * Phase 5 gate: randomized concurrent money simulation against a throwaway PostgreSQL 17.
 *
 *   pnpm --filter @tw/api simulate:ledger -- --ops 10000 --seed 42 --users 20 --concurrency 16
 *
 * Never touches the development database (Docker required). Exits 1 if anything fails to
 * reconcile, an invariant breaks, a replay posts twice or an unexpected error occurs.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createPrismaClient } from '../src/core/db/prisma';
import { runLedgerSimulation } from '../test/ledger-simulation';

const { values } = parseArgs({
  options: {
    ops: { type: 'string', default: '10000' },
    seed: { type: 'string', default: String(Date.now() % 1_000_000) },
    users: { type: 'string', default: '20' },
    concurrency: { type: 'string', default: '16' },
  },
});
const operations = Number(values.ops);
const seed = Number(values.seed);

console.log(
  `Starting PostgreSQL 17… (ops=${operations}, seed=${seed}, users=${values.users}, concurrency=${values.concurrency})`,
);
const container = await new PostgreSqlContainer('postgres:17-alpine')
  .withDatabase('ledger_simulation')
  .start();
const databaseUrl = container.getConnectionUri();
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: 'pipe',
});

const prisma = createPrismaClient(databaseUrl);
let exitCode = 1;
try {
  const result = await runLedgerSimulation(prisma, {
    operations,
    seed,
    users: Number(values.users),
    concurrency: Number(values.concurrency),
    onProgress: (done) => console.log(`  ${done} / ${operations}`),
  });

  console.log('\nOperations (ok / rejected by business rules):');
  console.table(result.stats);
  console.log('Rejections:', result.rejections);
  console.log('Totals:', result.totals);
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);

  const problems = [
    ...result.failures.map((f) => `unexpected error in ${f.op}: ${f.error}`),
    ...result.replayMismatches.map((m) => `replay posted twice: ${m}`),
    ...result.invariantViolations,
    ...result.reconciliation.issues.map(
      (i) => `${i.check} ${i.entityType} ${i.entityId}: ${i.detail}`,
    ),
  ];
  if (problems.length === 0) {
    console.log(
      `\nPASS: ${result.reconciliation.walletsChecked} wallets reconciled, 0 issues (seed ${seed}).`,
    );
    exitCode = 0;
  } else {
    console.error(`\nFAIL: ${problems.length} problem(s) (seed ${seed}):`);
    for (const p of problems.slice(0, 50)) console.error(`  - ${p}`);
  }
} finally {
  await prisma.$disconnect();
  await container.stop();
}
process.exit(exitCode);
