import { readdirSync } from 'node:fs';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { useTestDatabase } from '../../test/db';
import { createUser } from '../../test/fixtures';
import { adminContext, ledgerFor } from '../../test/money';
import { createPrismaClient } from '../core/db/prisma';
import { readOnlyUrl, verifyRestore } from './verify-restore';

const prisma = useTestDatabase();
const readOnly = createPrismaClient(readOnlyUrl(inject('databaseUrl')));
afterAll(() => readOnly.$disconnect());

const migrations = readdirSync(new URL('../../prisma/migrations', import.meta.url), {
  withFileTypes: true,
})
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

async function someMoney() {
  const admin = await createUser(prisma, { role: 'ADMIN' });
  const member = await createUser(prisma);
  await ledgerFor(prisma).creditCash(
    { userId: member.id, amountMinor: 2500, adminId: admin.id, idempotencyKey: 'restore-1' },
    adminContext(admin.id),
  );
}

describe('verifyRestore (backup restore drill)', () => {
  it('passes on an intact database, through a read-only connection, and writes nothing', async () => {
    await someMoney();
    const settingsBefore = await prisma.appSetting.count();
    const report = await verifyRestore(readOnly, migrations);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.migrations).toEqual({ applied: migrations.length, failed: [], missing: [] });
    expect(report.counts).toMatchObject({ users: 2, wallets: 1, transactions: 1 });
    expect(report.latest.ledgerAt).not.toBeNull();
    expect(report.reconciliation).toMatchObject({ walletsChecked: 1, issues: 0 });
    expect(await prisma.appSetting.count()).toBe(settingsBefore);
  });

  it('the read-only connection really refuses writes', async () => {
    await expect(
      readOnly.$executeRawUnsafe(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('x', '1', now())",
      ),
    ).rejects.toThrow(/read-only/);
  });

  it('reports missing migrations and books that do not add up', async () => {
    await someMoney();
    // Simulate a damaged copy: the cached balance no longer matches the ledger.
    await prisma.wallet.updateMany({ data: { balanceMinor: 9999 } });
    const report = await verifyRestore(readOnly, [...migrations, '20991231000000_future']);
    expect(report.ok).toBe(false);
    expect(report.migrations.missing).toEqual(['20991231000000_future']);
    expect(report.reconciliation.issues).toBeGreaterThan(0);
    expect(report.problems).toHaveLength(2);
  });
});
