// Every HTTP handler function must parse its input via Zod before touching
// any other data. Scope: files under src/runtime/http/ with an async function
// named like `handle*` — the first statement of the body must be a
// `.parse()` or `.safeParse()` call, assigned to a const.
//
// This is a structural check — not a type check. It catches "forgot to
// validate" at the earliest possible point.

function isZodCall(expr) {
  // X.safeParse(...) or X.parse(...)
  if (expr.type !== 'CallExpression') return false;
  const callee = expr.callee;
  if (callee.type !== 'MemberExpression') return false;
  if (callee.property.type !== 'Identifier') return false;
  return callee.property.name === 'safeParse' || callee.property.name === 'parse';
}

const MAX_STATEMENTS_BEFORE_PARSE = 5;

const SKIP_KEYS = new Set(['parent', 'loc', 'range', 'tokens', 'comments']);

function statementParses(stmt) {
  if (!stmt) return false;
  let found = false;
  const seen = new WeakSet();
  function walk(n) {
    if (found || !n || typeof n !== 'object') return;
    if (seen.has(n)) return;
    seen.add(n);
    if (n.type === 'CallExpression' && isZodCall(n)) {
      found = true;
      return;
    }
    for (const k of Object.keys(n)) {
      if (SKIP_KEYS.has(k)) continue;
      const v = n[k];
      if (!v) continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object' && v.type) walk(v);
    }
  }
  walk(stmt);
  return found;
}

function parsesEarly(body) {
  // Accept a parse call anywhere within the first N executable statements.
  // This accommodates defensive null-guards / early returns that legitimately
  // run before the parse, without letting the parse drift to the middle of
  // the handler.
  let seen = 0;
  for (const s of body.body) {
    if (s.type === 'EmptyStatement') continue;
    if (s.type === 'ExpressionStatement' && s.expression.type === 'Literal') continue;
    if (statementParses(s)) return true;
    seen++;
    if (seen >= MAX_STATEMENTS_BEFORE_PARSE) break;
  }
  return false;
}

function isHandlerFunction(node) {
  // Named async function whose name starts with "handle".
  if (node.type !== 'FunctionDeclaration') return false;
  if (!node.async) return false;
  if (!node.id || node.id.type !== 'Identifier') return false;
  return /^handle[A-Z]/.test(node.id.name);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'HTTP handler functions (`async function handleX(...)`) must begin with a Zod .parse() or .safeParse() call — Zod at every boundary (core belief #4).',
    },
    schema: [],
    messages: {
      missing:
        'Handler `{{name}}` does not start with a Zod .parse() or .safeParse() call. Parse the request body / params at the boundary before any other logic.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!filename.includes('/src/runtime/http/')) return {};
    return {
      FunctionDeclaration(node) {
        if (!isHandlerFunction(node)) return;
        if (parsesEarly(node.body)) return;
        context.report({ node: node.id, messageId: 'missing', data: { name: node.id.name } });
      },
    };
  },
};
