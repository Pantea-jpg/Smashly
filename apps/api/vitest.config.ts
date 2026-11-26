import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    restoreMocks: true,
    // Phase 9 coverage targets (roadmap): money domain ≥ 95%, services ≥ 85%, overall ≥ 80%.
    // Enforced in CI (`pnpm test` runs with --coverage); a drop below a floor fails the build.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/generated/**',
        // Process entry points: composition only, exercised by the dev/deploy smoke checks.
        'src/main.ts',
        'src/worker.ts',
        'src/verify-restore.ts',
      ],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
        // Money domain: the ledger, payments and attendance charging, and their pure math.
        'src/modules/wallets/**/*.ts': { lines: 95, statements: 95 },
        'src/modules/payments/**/*.ts': { lines: 95, statements: 95 },
        'src/modules/trainings/attendance.service.ts': { lines: 95, statements: 95 },
        'src/modules/trainings/domain/**/*.ts': { lines: 95, statements: 95 },
        'src/integrations/payments/**/*.ts': { lines: 95, statements: 95 },
        // Every other service.
        'src/modules/**/*.service.ts': { lines: 85, statements: 85 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
        },
      },
      {
        // Real PostgreSQL via Testcontainers (Docker required). Files share one database,
        // so they run one at a time.
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
