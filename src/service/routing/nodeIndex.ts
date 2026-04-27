import type { NodeRef } from '../../providers/serviceRegistry.js';

export interface NodeIndex {
  list(): readonly NodeRef[];
  get(id: string): NodeRef | undefined;
  findIdByUrl(url: string): string | undefined;
}

/**
 * Snapshot of the registry-daemon's known-nodes set, indexed for sync
 * lookups. The composition root populates this once at startup from
 * `serviceRegistry.listKnown()`; subsequent ticks of the engine's
 * background work (quote refresher, metrics sampler, admin endpoints,
 * outbound-request labelling) read it without touching the daemon.
 *
 * v1 is start-time-static — membership churn surfaces only via process
 * restart. The scaffolding tolerates a `replaceAll` so a future
 * registry-watch loop can refresh the index without code-shape changes.
 */
export function createNodeIndex(initial: readonly NodeRef[] = []): NodeIndex & {
  replaceAll(refs: readonly NodeRef[]): void;
} {
  let byId = new Map<string, NodeRef>();
  let urlToId = new Map<string, string>();

  function rebuild(refs: readonly NodeRef[]): void {
    byId = new Map();
    urlToId = new Map();
    for (const ref of refs) {
      byId.set(ref.id, ref);
      urlToId.set(ref.url, ref.id);
    }
  }

  rebuild(initial);

  return {
    list(): readonly NodeRef[] {
      return Array.from(byId.values());
    },
    get(id: string): NodeRef | undefined {
      return byId.get(id);
    },
    findIdByUrl(url: string): string | undefined {
      return urlToId.get(url);
    },
    replaceAll(refs: readonly NodeRef[]): void {
      rebuild(refs);
    },
  };
}
