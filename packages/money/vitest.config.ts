import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Money arithmetic is the core of every balance: Phase 9 floor of 95% (CI fails below).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 80 },
    },
  },
});
