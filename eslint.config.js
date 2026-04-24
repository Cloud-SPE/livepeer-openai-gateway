// ESLint 9 flat config.
// Full rule set — including the custom layer-check plugin — is wired in exec-plan 0001-repo-scaffold.

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.d.ts'],
  },
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
];
