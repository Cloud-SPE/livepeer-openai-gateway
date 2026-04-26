import { playwrightLauncher } from '@web/test-runner-playwright';

/** @type {import('@web/test-runner').TestRunnerConfig} */
export default {
  files: ['tests/wtr/**/*.test.js'],
  browsers: [playwrightLauncher({ product: 'chromium' })],
  rootDir: '..',
  nodeResolve: { exportConditions: ['browser', 'development'] },
  testFramework: { config: { ui: 'bdd', timeout: '4000' } },
  testsFinishTimeout: 60_000,
  coverage: false,
};
