// ESLint 9 flat config.

import tseslint from 'typescript-eslint';
import livepeerBridge from './lint/eslint-plugin-livepeer-bridge/index.js';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.d.ts',
      'src/providers/payerDaemon/gen/**',
      'bridge-ui/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'packages/bridge-core/src/**/*.ts'],
    plugins: {
      'livepeer-bridge': livepeerBridge,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: false,
      },
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'livepeer-bridge/layer-check': 'error',
      'livepeer-bridge/no-cross-cutting-import': 'error',
      'livepeer-bridge/zod-at-boundary': 'error',
      'livepeer-bridge/no-secrets-in-logs': 'error',
      'livepeer-bridge/file-size': 'warn',
      'livepeer-bridge/types-shape': 'error',
    },
  },
);
