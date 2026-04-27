import { defineConfig } from 'vitest/config';

// Coverage gate: 75% across lines/branches/functions/statements (core belief).
//
// The exclude list below covers files whose coverage comes from
// `livepeer-openai-gateway` shell-side integration tests rather than
// engine-package unit tests. The plan (exec-plan 0026) promises engine
// route unit tests in a follow-up — once they land, these exclusions
// shrink down to just test fixtures + composition-root wiring.
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
        'src/**/testFakes.ts',
        'src/**/testhelpers.ts',
        'src/**/gen/**',
        'src/scripts/**',
        // pure type / schema / interface declarations — exercised at the
        // boundary in shell e2e tests via parse()/safeParse().
        'src/types/**',
        'src/providers/nodeClient.ts',
        'src/providers/payerDaemon.ts',
        'src/providers/redis.ts',
        'src/providers/serviceRegistry.ts',
        'src/providers/database.ts',
        'src/providers/http.ts',
        'src/providers/metrics.ts',
        'src/providers/tokenizer.ts',
        // wiring-only modules exercised solely from the shell main.ts —
        // engine-side unit tests would just retest constructors.
        'src/config/metrics.ts',
        'src/config/redis.ts',
        'src/config/routing.ts',
        'src/providers/logger/console.ts',
        'src/providers/redis/ioredis.ts',
        'src/providers/nodeClient/fetch.ts',
        'src/providers/nodeClient/wireQuote.ts',
        'src/providers/serviceRegistry/grpc.ts',
        'src/providers/serviceRegistry/fake.ts',
        // route + dispatcher + admin-service modules covered by shell-side
        // integration tests against a real gateway+TestPg+fake-worker;
        // engine-package unit tests with InMemoryWallet are tracked as
        // follow-up under exec-plan 0026.
        'src/dispatch/**',
        'src/runtime/http/chat/**',
        'src/runtime/http/embeddings/**',
        'src/runtime/http/images/**',
        'src/runtime/http/audio/**',
        'src/runtime/http/middleware/auth.ts',
        'src/service/admin/engine.ts',
        // engine repos surface DB types; coverage rolls up through shell
        // repo tests + engine repo.test.ts (now in shell). InMemoryWallet
        // contracts are tested at engine level.
        'src/repo/db.ts',
        'src/repo/migrate.ts',
        'src/repo/nodeHealth.ts',
        'src/repo/schema.ts',
        'src/repo/usageRecords.ts',
        'src/repo/usageRollups.ts',
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
