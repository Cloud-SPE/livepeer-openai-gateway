import { defineConfig } from 'vitest/config';

// Coverage gate: 75% across lines/branches/functions/statements (core belief).
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
        'src/main.ts',
        'src/scripts/**',
        // Thin config/bootstrap wrappers.
        'src/config/admin.ts',
        'src/config/payerDaemon.ts',
        // Transport adapters are integration-covered elsewhere and
        // would otherwise dominate the line threshold.
        'src/providers/payerDaemon.ts',
        'src/providers/payerDaemon/**',
        'src/providers/serviceRegistry/grpc.ts',
        'src/providers/stripe/sdk.ts',
        // Thin route wrappers over covered dispatchers/services.
        'src/runtime/http/audio/speech.ts',
        'src/runtime/http/audio/transcriptions.ts',
        'src/runtime/http/chat/completions.ts',
        'src/runtime/http/chat/streaming.ts',
        'src/runtime/http/embeddings/index.ts',
        'src/runtime/http/images/generations.ts',
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
