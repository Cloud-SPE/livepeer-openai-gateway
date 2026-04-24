#!/usr/bin/env node
// doc-gardener — validates docs/** structural invariants:
//   - Exec-plans in `active/` have `status: active`; in `completed/` have
//     `status ∈ {completed, abandoned}`.
//   - Design-docs have `title`, `status`, `last-reviewed`; status is one of
//     `proposed | accepted | verified | deprecated`.
//   - Product-specs have `title`, `status`, `last-reviewed`.
//   - Every `exec-plan` has `closed: YYYY-MM-DD` when status is completed or
//     abandoned; closed date >= opened date.
//   - Internal `.md` cross-links under `docs/` resolve to an existing file.
//   - Design-docs do not link into `exec-plans/` (plans are transient; docs
//     are durable — conventions section of `design-docs/index.md`).
//
// Exit 0 on clean, 1 on any violation. One diagnostic per violation.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import yaml from 'js-yaml';

const DOCS_DIR = resolve(process.cwd(), 'docs');

const DESIGN_STATUS = new Set(['proposed', 'accepted', 'verified', 'deprecated']);
const PLAN_ACTIVE_STATUS = new Set(['active', 'blocked']);
const PLAN_COMPLETED_STATUS = new Set(['completed', 'abandoned']);

let diagnostics = 0;

function report(file, line, ruleId, message) {
  const rel = relative(process.cwd(), file);
  console.error(`${rel}:${line}: ${ruleId}: ${message}`);
  diagnostics++;
}

async function* walkMarkdown(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(p);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield p;
  }
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { data: null, bodyStartLine: 1 };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { data: null, bodyStartLine: 1 };
  const raw = text.slice(4, end);
  try {
    return { data: yaml.load(raw), bodyStartLine: raw.split('\n').length + 2 };
  } catch {
    return { data: null, bodyStartLine: 1 };
  }
}

function required(file, data, key, ruleId) {
  if (!data || data[key] === undefined || data[key] === null || data[key] === '') {
    report(file, 1, ruleId, `missing required frontmatter key \`${key}\``);
    return false;
  }
  return true;
}

function validateExecPlan(file, data) {
  const inActive = file.includes('/exec-plans/active/');
  const inCompleted = file.includes('/exec-plans/completed/');
  if (!required(file, data, 'id', 'plan-frontmatter')) return;
  if (!required(file, data, 'slug', 'plan-frontmatter')) return;
  if (!required(file, data, 'title', 'plan-frontmatter')) return;
  if (!required(file, data, 'status', 'plan-frontmatter')) return;
  if (!required(file, data, 'opened', 'plan-frontmatter')) return;

  const status = String(data.status);
  if (inActive && !PLAN_ACTIVE_STATUS.has(status)) {
    report(
      file,
      1,
      'plan-status-location',
      `file is under active/ but has status=\`${status}\`; expected one of ${[...PLAN_ACTIVE_STATUS].join(', ')}`,
    );
  }
  if (inCompleted && !PLAN_COMPLETED_STATUS.has(status)) {
    report(
      file,
      1,
      'plan-status-location',
      `file is under completed/ but has status=\`${status}\`; expected one of ${[...PLAN_COMPLETED_STATUS].join(', ')}`,
    );
  }

  if (PLAN_COMPLETED_STATUS.has(status)) {
    if (!data.closed) {
      report(
        file,
        1,
        'plan-closed-required',
        `status=\`${status}\` requires a \`closed: YYYY-MM-DD\` field`,
      );
    } else if (data.opened && String(data.closed) < String(data.opened)) {
      report(
        file,
        1,
        'plan-closed-before-opened',
        `closed=\`${data.closed}\` precedes opened=\`${data.opened}\``,
      );
    }
  }
}

function validateDesignOrSpec(file, data, kind) {
  const ruleId = kind === 'design' ? 'design-doc-frontmatter' : 'product-spec-frontmatter';
  if (!required(file, data, 'title', ruleId)) return;
  if (!required(file, data, 'status', ruleId)) return;
  if (!required(file, data, 'last-reviewed', ruleId)) return;
  if (kind === 'design') {
    const status = String(data.status);
    if (!DESIGN_STATUS.has(status)) {
      report(
        file,
        1,
        'design-doc-status',
        `status=\`${status}\` not in ${[...DESIGN_STATUS].join(', ')}`,
      );
    }
  }
}

const LINK_RE = /\[[^\]]+\]\(([^)\s]+)\)/g;

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function validateCrossLinks(file, text) {
  const fileDir = dirname(file);
  for (const match of text.matchAll(LINK_RE)) {
    const target = match[1];
    if (!target) continue;
    if (/^https?:\/\//.test(target)) continue;
    if (target.startsWith('#')) continue; // in-page anchor
    if (target.startsWith('mailto:')) continue;
    const [rawPath] = target.split('#');
    if (!rawPath) continue; // pure anchor

    // Only validate links that point to .md under docs/, root docs, or
    // relative paths to other markdown files.
    if (!rawPath.endsWith('.md')) continue;

    const resolvedTarget = resolve(fileDir, rawPath);
    if (!(await fileExists(resolvedTarget))) {
      report(file, 1, 'broken-link', `markdown link resolves to missing file: ${target}`);
    }

    // Design-doc rule: no cross-links into exec-plans/.
    if (file.includes('/design-docs/') && resolvedTarget.includes('/exec-plans/')) {
      report(
        file,
        1,
        'design-doc-links-into-plans',
        `design-doc links into exec-plans/ (plans are transient; docs are durable): ${target}`,
      );
    }
  }
}

async function main() {
  for await (const file of walkMarkdown(DOCS_DIR)) {
    const text = await readFile(file, 'utf8');
    const { data } = parseFrontmatter(text);

    if (file.includes('/exec-plans/active/') || file.includes('/exec-plans/completed/')) {
      if (!data) {
        report(file, 1, 'plan-frontmatter', 'missing or malformed frontmatter');
      } else {
        validateExecPlan(file, data);
      }
    } else if (file.includes('/design-docs/') && !file.endsWith('/index.md')) {
      if (!data) {
        report(file, 1, 'design-doc-frontmatter', 'missing or malformed frontmatter');
      } else {
        validateDesignOrSpec(file, data, 'design');
      }
    } else if (file.includes('/product-specs/') && !file.endsWith('/index.md')) {
      if (!data) {
        report(file, 1, 'product-spec-frontmatter', 'missing or malformed frontmatter');
      } else {
        validateDesignOrSpec(file, data, 'spec');
      }
    }

    await validateCrossLinks(file, text);
  }

  if (diagnostics > 0) {
    console.error(`\ndoc-gardener: ${diagnostics} violation(s). Exiting 1.`);
    process.exit(1);
  }
  console.warn('doc-gardener: all docs pass.');
}

main().catch((err) => {
  console.error('doc-gardener: unexpected error', err);
  process.exit(2);
});
