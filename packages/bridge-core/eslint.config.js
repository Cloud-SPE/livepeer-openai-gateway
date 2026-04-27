// ESLint 9 flat config for @cloud-spe/bridge-core. Inherits the root
// repository's lint plugin (livepeer-bridge) so the same layer rule and
// other custom checks apply here as in the shell. Stage 4 of the
// engine-extraction plan splits this into a standalone published plugin
// (`@cloud-spe/eslint-plugin-bridge-core`) when the package leaves this
// monorepo.

import tseslint from 'typescript-eslint';
import livepeerBridge from '../../lint/eslint-plugin-livepeer-bridge/index.js';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.d.ts', 'src/**/gen/**'],
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
