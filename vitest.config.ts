import { defineConfig } from 'vitest/config';

// Coverage is strictly enforced at 75% across lines/branches/functions/statements.
// This is a core belief — see docs/design-docs/core-beliefs.md.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: 'default',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/index.ts',
        'src/**/testPg.ts',
        'src/**/testRedis.ts',
        'src/**/gen/**',
        'src/main.ts',
        'src/scripts/**',
      ],
      thresholds: {
        lines: 75,
        branches: 75,
        functions: 75,
        statements: 75,
      },
    },
  },
});
