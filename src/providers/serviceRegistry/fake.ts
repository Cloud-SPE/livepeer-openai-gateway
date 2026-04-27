import type {
  NodeRef,
  SelectQuery,
  ServiceRegistryClient,
} from '../serviceRegistry.js';
import type { NodeCapability } from '../../types/node.js';

export interface FakeRegistryNode {
  id: string;
  url: string;
  capabilities: NodeCapability[];
  weight?: number;
  /** Optional model filter — empty/omitted = "any model accepted". */
  supportedModels?: readonly string[];
  /** Optional tier filter — empty/omitted = "any tier accepted". */
  tierAllowed?: readonly ('free' | 'prepaid')[];
}

export interface FakeRegistryOptions {
  nodes: readonly FakeRegistryNode[];
}

/**
 * In-memory ServiceRegistryClient for tests. Mirrors the shape of the
 * gRPC client without the daemon dependency. select() applies the same
 * filters the real daemon does (capability + optional model + optional
 * tier), then the caller's NodeRef[] is returned.
 *
 * Returns nodes sorted by weight desc — same convention the gRPC daemon
 * uses, so dispatchers see identical ordering.
 */
export function createFakeServiceRegistry(opts: FakeRegistryOptions): ServiceRegistryClient {
  const all = opts.nodes;

  function toRef(node: FakeRegistryNode): NodeRef {
    return {
      id: node.id,
      url: node.url,
      capabilities: node.capabilities,
      weight: node.weight ?? 1,
    };
  }

  return {
    async select(query: SelectQuery): Promise<NodeRef[]> {
      const exclude = new Set(query.excludeIds ?? []);
      const matches = all.filter((n) => {
        if (exclude.has(n.id)) return false;
        if (!n.capabilities.includes(query.capability)) return false;
        if (query.model && n.supportedModels && !n.supportedModels.includes(query.model)) {
          return false;
        }
        if (
          query.tier &&
          n.tierAllowed &&
          !n.tierAllowed.includes(query.tier as 'free' | 'prepaid')
        ) {
          return false;
        }
        return true;
      });
      return matches
        .map(toRef)
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    },

    async listKnown(capability?: NodeCapability): Promise<NodeRef[]> {
      const matches = capability
        ? all.filter((n) => n.capabilities.includes(capability))
        : all;
      return matches.map(toRef);
    },
  };
}
