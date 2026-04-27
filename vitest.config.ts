import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineSrc = path.resolve(__dirname, 'packages/bridge-core/src');

// Coverage is strictly enforced at 75% across lines/branches/functions/statements.
// This is a core belief — see docs/design-docs/core-beliefs.md.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@cloud-spe\/bridge-core$/, replacement: `${engineSrc}/index.ts` },
      { find: /^@cloud-spe\/bridge-core\/(.*)$/, replacement: `${engineSrc}/$1` },
    ],
  },
  test: {
    include: ['src/**/*.test.ts', 'packages/bridge-core/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: 'default',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts', 'packages/bridge-core/src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/index.ts',
        'src/**/testPg.ts',
        'src/**/testRedis.ts',
        'src/**/gen/**',
        'src/main.ts',
        'src/scripts/**',
        'packages/bridge-core/src/**/*.test.ts',
        'packages/bridge-core/src/**/index.ts',
        'packages/bridge-core/src/**/testPg.ts',
        'packages/bridge-core/src/**/testRedis.ts',
        'packages/bridge-core/src/**/gen/**',
        'packages/bridge-core/src/scripts/**',
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
