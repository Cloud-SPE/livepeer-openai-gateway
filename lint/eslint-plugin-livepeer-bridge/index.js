// Local ESLint plugin — ships the six architectural lints for the bridge.
// See docs/exec-plans/completed/0014-lint-plugin.md for rationale.
import layerCheck from './rules/layer-check.js';
import noCrossCuttingImport from './rules/no-cross-cutting-import.js';
import zodAtBoundary from './rules/zod-at-boundary.js';
import noSecretsInLogs from './rules/no-secrets-in-logs.js';
import fileSize from './rules/file-size.js';
import typesShape from './rules/types-shape.js';

export default {
  meta: { name: 'eslint-plugin-livepeer-bridge', version: '0.0.0' },
  rules: {
    'layer-check': layerCheck,
    'no-cross-cutting-import': noCrossCuttingImport,
    'zod-at-boundary': zodAtBoundary,
    'no-secrets-in-logs': noSecretsInLogs,
    'file-size': fileSize,
    'types-shape': typesShape,
  },
};
