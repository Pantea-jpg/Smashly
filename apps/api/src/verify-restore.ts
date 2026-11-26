/**
 * Backup restore drill: verifies a restored database without changing it.
 * Run inside Render (Shell tab of the API service, or a one-off job) with DATABASE_URL pointing
 * at the RESTORED database:
 *   DATABASE_URL=<restored internal URL> node dist/verify-restore.js
 * Prints a JSON report; exit code 0 when everything checks out, 1 otherwise.
 */
import { readdirSync } from 'node:fs';
import { createPrismaClient } from './core/db/prisma';
import { readOnlyUrl, verifyRestore } from './jobs/verify-restore';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('Set DATABASE_URL to the restored database');
  // In the image the migrations live in ./prisma/migrations (see Dockerfile); locally in apps/api.
  const expected = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  // Every pooled connection is read-only: the check cannot change the restored data.
  const prisma = createPrismaClient(readOnlyUrl(url));
  try {
    const report = await verifyRestore(prisma, expected);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      report.ok ? 'RESTORE OK\n' : `RESTORE PROBLEMS: ${report.problems.join('; ')}\n`,
    );
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `verify-restore failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
