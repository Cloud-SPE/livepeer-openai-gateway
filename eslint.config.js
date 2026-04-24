// ESLint 9 flat config.
// Full custom rule set (layer-check, no-cross-cutting-import, zod-at-boundary,
// no-secrets-in-logs, file-size) is tracked in docs/exec-plans/tech-debt-tracker.md.

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.d.ts'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // TODO: @livepeer-bridge/layer-check — enforces the src/ dependency rule.
      // TODO: @livepeer-bridge/no-cross-cutting-import — enforces providers boundary.
      // TODO: @livepeer-bridge/zod-at-boundary — enforces Zod parse at HTTP/gRPC edges.
      // TODO: @livepeer-bridge/no-secrets-in-logs — rejects apiKey/privateKey/passphrase in log args.
    },
  },
);
