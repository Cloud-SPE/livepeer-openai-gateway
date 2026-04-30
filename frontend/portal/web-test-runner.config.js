import { playwrightLauncher } from '@web/test-runner-playwright';

/** @type {import('@web/test-runner').TestRunnerConfig} */
export default {
  files: ['tests/wtr/**/*.test.js'],
  // Real browser for accurate component semantics (light DOM, custom elements,
  // Popover API, dialog focus traps). Chromium covers the modern-CSS surface
  // we ship — Firefox and WebKit can be added once features stabilize.
  browsers: [playwrightLauncher({ product: 'chromium' })],
  // rootDir at frontend/ so cross-directory imports (../shared/...) work in
  // browser file URLs; nodeResolve walks up from portal/ for bare specifiers
  // and finds @open-wc/testing in portal/node_modules.
  rootDir: '..',
  nodeResolve: {
    exportConditions: ['browser', 'development'],
  },
  testFramework: {
    config: {
      ui: 'bdd',
      timeout: '4000',
    },
  },
  testsFinishTimeout: 60_000,
  // Keep coverage off in v1 — vitest already enforces the global floor.
  coverage: false,
};
