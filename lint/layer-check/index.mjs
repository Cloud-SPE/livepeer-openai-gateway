#!/usr/bin/env node
// layer-check — enforces the src/ dependency stack documented in
// docs/design-docs/architecture.md.
//
// STATUS: stub. Full AST-based implementation is tracked in a follow-on
// exec-plan (see docs/exec-plans/tech-debt-tracker.md). This stub keeps
// `npm run lint` green so CI passes until the real lint lands.

console.warn(
  'layer-check: stub running. AST-based enforcement lands in a follow-on exec-plan. ' +
    'See docs/design-docs/architecture.md for the rule being enforced.',
);
process.exit(0);
