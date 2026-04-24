// Forbids importing cross-cutting libraries (pg, ioredis, stripe, @grpc/*,
// tiktoken, fastify, etc.) outside src/providers/. The whole point of the
// providers layer is to be the one place these libraries leak in.

const FORBIDDEN = new Set([
  'pg',
  'ioredis',
  'stripe',
  'tiktoken',
  'fastify',
  'fastify-raw-body',
  '@fastify/sensible',
  'viem',
  'pino',
]);

const FORBIDDEN_PREFIXES = ['@grpc/'];

function isForbidden(spec) {
  if (FORBIDDEN.has(spec)) return true;
  for (const p of FORBIDDEN_PREFIXES) {
    if (spec.startsWith(p)) return true;
  }
  return false;
}

function isExempt(filename) {
  return (
    filename.includes('/src/providers/') ||
    filename.endsWith('/src/main.ts') ||
    filename.endsWith('.test.ts')
  );
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Cross-cutting libraries (pg, ioredis, stripe, @grpc/*, fastify, tiktoken, viem, pino) must only be imported from src/providers/. Everything else imports the provider interface.',
    },
    schema: [],
    messages: {
      forbidden:
        'Cross-cutting library `{{spec}}` may only be imported under src/providers/. Import the provider interface from src/providers/<name>.ts instead.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (isExempt(filename)) return {};
    if (!filename.includes('/src/')) return {};

    return {
      ImportDeclaration(node) {
        // Type-only imports don't create a runtime dependency — `tsc` strips
        // them. Treating `import type { FastifyInstance } from 'fastify'` as
        // a cross-cutting violation is overzealous.
        if (node.importKind === 'type') return;
        const spec = node.source.value;
        if (typeof spec !== 'string') return;
        if (!isForbidden(spec)) return;
        // Per-specifier type-only ({ type X } in the import list) can mix with
        // value imports; if every specifier is type-only, skip.
        if (
          node.specifiers.length > 0 &&
          node.specifiers.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type')
        ) {
          return;
        }
        context.report({ node: node.source, messageId: 'forbidden', data: { spec } });
      },
    };
  },
};
