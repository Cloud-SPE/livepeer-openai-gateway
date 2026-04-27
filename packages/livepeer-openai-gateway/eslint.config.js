// ESLint 9 flat config for livepeer-openai-gateway (the Cloud-SPE shell).
// Inherits the same livepeer-bridge plugin as the engine; the layer rule
// scopes via file paths so the shell-side src/ tree is checked the same
// way the root tree is.

import tseslint from 'typescript-eslint';
import livepeerBridge from '../../lint/eslint-plugin-livepeer-bridge/index.js';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.d.ts'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
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
