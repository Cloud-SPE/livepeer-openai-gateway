// Root flat config — applies only outside the workspace packages
// (frontend/, lint/, scripts/, doc-gardener helpers). Each package owns
// its own eslint.config.js with the livepeer-bridge plugin rules; running
// `npm run lint` (which delegates to `--workspaces`) lints them there.

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.d.ts',
      'packages/**',
      'frontend/**',
    ],
  },
  ...tseslint.configs.recommended,
);
