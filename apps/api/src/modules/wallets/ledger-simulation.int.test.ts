import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { runLedgerSimulation } from '../../../test/ledger-simulation';

const prisma = useTestDatabase();

/**
 * CI-sized run of the randomized money simulation. The 10,000-operation gate runs with
 * `pnpm --filter @tw/api simulate:ledger`.
 */
describe('randomized ledger simulation', () => {
  it.each([1, 2])(
    'reconciles after 1,500 concurrent mixed operations (seed %i)',
    { timeout: 300_000 },
    async (seed) => {
      const result = await runLedgerSimulation(prisma, {
        operations: 1_500,
        seed,
        users: 8,
        concurrency: 10,
      });

      expect(result.failures).toEqual([]);
      expect(result.replayMismatches).toEqual([]);
      expect(result.invariantViolations).toEqual([]);
      expect(result.reconciliation.issues).toEqual([]);
      // Every kind of operation actually happened.
      for (const [op, { ok }] of Object.entries(result.stats)) expect(ok, op).toBeGreaterThan(0);
    },
  );
});
