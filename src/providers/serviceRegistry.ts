import type { NodeCapability } from '../types/node.js';

/**
 * Engine-internal provider interface for node discovery and selection.
 * NOT operator-overridable — the engine commits to
 * `livepeer-modules-project/service-registry-daemon` as the canonical
 * source of node identity (per exec-plan 0024 / 0025). The production
 * implementation is `createGrpcServiceRegistryClient` in
 * `serviceRegistry/grpc.ts`; tests fake this surface directly.
 */
export interface ServiceRegistryClient {
  /**
   * Return candidate nodes matching the query. The daemon's selection
   * algorithm picks nodes by capability + model + tier + geo + weight;
   * the bridge applies its local circuit-breaker exclusion via
   * `excludeIds`. The bridge does the final pick (weighted random or
   * top-N) over the returned slice.
   *
   * gRPC impl returns whatever the daemon's `Select` RPC returns; the
   * bridge applies its bridge-local circuit-breaker exclusion afterward.
   */
  select(query: SelectQuery): Promise<NodeRef[]>;

  /**
   * Snapshot of all known (registered + healthy from the daemon's POV)
   * nodes, optionally filtered to a single capability. Used by the
   * bridge's quoteRefresher for periodic `/quotes` polling and by the
   * operator dashboard for the node-list view.
   */
  listKnown(capability?: NodeCapability): Promise<NodeRef[]>;
}

export interface SelectQuery {
  capability: NodeCapability;
  model?: string;
  tier?: string;
  excludeIds?: string[];
}

export interface NodeRef {
  id: string;
  url: string;
  capabilities: NodeCapability[];
  weight?: number;
  /**
   * Daemon-reported fields (the proto Node, with eth_address, geo, etc.).
   * Callers narrow via the proto type when they need them.
   */
  metadata?: unknown;
}
