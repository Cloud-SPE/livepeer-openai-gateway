// Enforces the `types → config → repo → service → runtime → ui` dependency
// stack from docs/design-docs/architecture.md. `providers/` is reachable from
// every layer; everything else obeys the partial order strictly.

const LAYER_ORDER = ['types', 'config', 'repo', 'service', 'runtime', 'ui'];

/** Classify a file path relative to src/ into a layer name (or null). */
function layerOf(filename) {
  const m = filename.match(/\/src\/([^/]+)\//);
  if (!m) return null;
  const top = m[1];
  if (top === 'providers') return 'providers';
  if (LAYER_ORDER.includes(top)) return top;
  return null;
}

function layerRank(layer) {
  return LAYER_ORDER.indexOf(layer);
}

/** Resolve an import spec relative to src/ into a layer name, or null for
 *  external packages / non-src imports. */
function importTargetLayer(currentFile, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  // Cheap heuristic: walk the relative path from currentFile's dir and find
  // the src/<top> segment of the resolved target.
  const cwd = currentFile.replace(/\/[^/]+$/, '');
  const parts = cwd.split('/').concat(spec.split('/'));
  const resolved = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      resolved.pop();
    } else {
      resolved.push(p);
    }
  }
  const srcIdx = resolved.indexOf('src');
  if (srcIdx === -1) return null;
  const top = resolved[srcIdx + 1];
  if (!top) return null;
  if (top === 'providers') return 'providers';
  if (LAYER_ORDER.includes(top)) return top;
  return null;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Enforce the src/ layer stack: types → config → repo → service → runtime → ui, plus providers/ reachable from all.',
    },
    schema: [],
    messages: {
      upstream:
        'File in layer `{{from}}` cannot import from layer `{{to}}`. Layers flow types → config → repo → service → runtime → ui; a layer may only depend on layers strictly below it (plus providers/).',
      crossDomain:
        'Cross-domain import inside `service/`: `{{fromDomain}}` cannot import from sibling domain `{{toDomain}}`. Compose via the layer above.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    // Test files routinely cross layers (integration tests assemble the full
    // stack; unit tests may import a test helper from another layer). Skip.
    if (filename.endsWith('.test.ts')) return {};
    const fromLayer = layerOf(filename);

    return {
      ImportDeclaration(node) {
        if (!fromLayer) return;
        const spec = node.source.value;
        if (typeof spec !== 'string') return;
        const toLayer = importTargetLayer(filename, spec);
        if (!toLayer) return;
        if (toLayer === 'providers') return; // Providers reachable from all.
        if (fromLayer === 'providers') return; // Providers can go anywhere.

        const fromRank = layerRank(fromLayer);
        const toRank = layerRank(toLayer);
        if (toRank > fromRank) {
          context.report({
            node: node.source,
            messageId: 'upstream',
            data: { from: fromLayer, to: toLayer },
          });
          return;
        }
        if (fromLayer === 'service' && toLayer === 'service') {
          // Cross-domain inside service/: billing can't import from routing, etc.
          const fromDomain = filename.match(/\/src\/service\/([^/]+)\//)?.[1] ?? '';
          const specMatch = spec.match(/\/service\/([^/]+)\//);
          const toDomain = specMatch?.[1];
          if (fromDomain && toDomain && fromDomain !== toDomain) {
            context.report({
              node: node.source,
              messageId: 'crossDomain',
              data: { fromDomain, toDomain },
            });
          }
        }
      },
    };
  },
};
