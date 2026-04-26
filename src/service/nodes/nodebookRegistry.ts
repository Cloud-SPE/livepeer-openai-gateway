import type {
  NodeRef,
  SelectQuery,
  ServiceRegistryClient,
} from '../../providers/serviceRegistry.js';
import type { NodeCapability } from '../../types/node.js';
import type { NodeBook, NodeEntry } from './nodebook.js';

export interface NodeBookRegistryDeps {
  nodeBook: NodeBook;
}

/**
 * Stage-1 `ServiceRegistryClient` impl: thin wrapper over today's
 * static-YAML `NodeBook`. Lets stage-1 refactor consumers behind a
 * registry-shaped API without yet wiring the
 * `livepeer-modules-project/service-registry-daemon` gRPC client (that
 * lands in stage 2 / exec-plan 0025).
 *
 * Selection semantics preserved from `NodeBook.findNodesFor`:
 *   - filter by capability + (optional) model + (optional) tier
 *   - exclude circuit-broken nodes
 *   - exclude nodes missing a quote for the requested capability
 *   - sort by config.weight desc
 *
 * The new `excludeIds` param applies an additional filter after the
 * NodeBook's own selection — stage-2 router uses this for bridge-local
 * circuit-breaker retry. Returns an empty array when no candidates
 * match (NodeBook.findNodesFor throws; the wrapper catches and returns
 * []) so the caller decides what "no eligible nodes" means.
 */
export function createNodeBookRegistry(deps: NodeBookRegistryDeps): ServiceRegistryClient {
  return {
    async select(query: SelectQuery): Promise<NodeRef[]> {
      const tier = query.tier as 'free' | 'prepaid' | undefined;
      const model = query.model;
      // NodeBook.findNodesFor requires a model and tier; when the caller
      // omits either we fall back to listKnown-by-capability and let the
      // caller filter.
      let entries: NodeEntry[];
      if (model && tier) {
        try {
          entries = deps.nodeBook.findNodesFor(model, tier, query.capability);
        } catch {
          return [];
        }
      } else {
        entries = deps.nodeBook
          .list()
          .filter(
            (e) =>
              e.config.enabled &&
              e.config.capabilities.includes(query.capability) &&
              e.circuit.status !== 'circuit_broken',
          );
      }
      const exclude = new Set(query.excludeIds ?? []);
      return entries.filter((e) => !exclude.has(e.config.id)).map(toNodeRef);
    },

    async listKnown(capability?: NodeCapability): Promise<NodeRef[]> {
      const entries = capability
        ? deps.nodeBook.list().filter((e) => e.config.capabilities.includes(capability))
        : deps.nodeBook.list();
      return entries.map(toNodeRef);
    },
  };
}

function toNodeRef(entry: NodeEntry): NodeRef {
  return {
    id: entry.config.id,
    url: entry.config.url,
    capabilities: entry.config.capabilities,
    weight: entry.config.weight,
    metadata: entry,
  };
}
