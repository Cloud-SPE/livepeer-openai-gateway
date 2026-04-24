// Every file in src/types/ (other than index.ts and *.test.ts) must export
// both a Zod schema (named `*Schema`) AND a TS type derived from it.
// Convention is honored today by every file in the directory; this makes
// the convention mechanical.

function isTypesFile(filename) {
  return (
    filename.includes('/src/types/') &&
    !filename.endsWith('/index.ts') &&
    !filename.endsWith('.test.ts')
  );
}

function isSchemaName(name) {
  return /Schema$/.test(name);
}

function isInferredType(node) {
  // `export type X = z.infer<typeof Y>` or `export type X = z.input/z.output<...>`
  if (node.type !== 'ExportNamedDeclaration') return false;
  const decl = node.declaration;
  if (!decl || decl.type !== 'TSTypeAliasDeclaration') return false;
  const ann = decl.typeAnnotation;
  if (!ann) return false;
  if (ann.type !== 'TSTypeReference') return false;
  const name = ann.typeName;
  if (name.type !== 'TSQualifiedName') return false;
  if (name.left.type !== 'Identifier' || name.left.name !== 'z') return false;
  if (name.right.type !== 'Identifier') return false;
  return ['infer', 'input', 'output'].includes(name.right.name);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every src/types/*.ts must export both a Zod schema (named `*Schema`) and at least one inferred TS type (`z.infer<typeof X>`).',
    },
    schema: [],
    messages: {
      missingSchema:
        '`src/types/` file does not export a Zod schema (any `export const *Schema`). Schemas are the source of truth for boundary validation.',
      missingType:
        '`src/types/` file does not export any `z.infer<typeof X>` / `z.input<...>` / `z.output<...>` type alias.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!isTypesFile(filename)) return {};

    let sawSchema = false;
    let sawInferred = false;

    return {
      ExportNamedDeclaration(node) {
        if (node.declaration && node.declaration.type === 'VariableDeclaration') {
          for (const d of node.declaration.declarations) {
            if (d.id.type === 'Identifier' && isSchemaName(d.id.name)) sawSchema = true;
          }
        }
        // Named re-exports: `export { XSchema }`
        if (node.specifiers) {
          for (const spec of node.specifiers) {
            if (
              spec.type === 'ExportSpecifier' &&
              spec.exported.type === 'Identifier' &&
              isSchemaName(spec.exported.name)
            ) {
              sawSchema = true;
            }
          }
        }
        if (isInferredType(node)) sawInferred = true;
      },
      'Program:exit'(node) {
        if (!sawSchema) context.report({ node, messageId: 'missingSchema' });
        if (!sawInferred) context.report({ node, messageId: 'missingType' });
      },
    };
  },
};
