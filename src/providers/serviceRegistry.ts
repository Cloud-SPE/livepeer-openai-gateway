import type { NodeCapability } from '../types/node.js';

/**
 * Engine-internal provider interface for node discovery and selection.
 * NOT operator-overridable — the engine commits to
 * `livepeer-modules-project/service-registry-daemon` as the canonical
 * source of node identity (per exec-plan 0024 / 0025). This interface
 * exists so stage 1 can refactor existing NodeBook callers behind a
 * registry-shaped API; stage 2 swaps the NodeBook-backed impl for a real
 * gRPC client to the daemon.
 */
export interface ServiceRegistryClient {
  /**
   * Return candidate nodes matching the query. The daemon's selection
   * algorithm picks nodes by capability + model + tier + geo + weight;
   * the bridge applies its local circuit-breaker exclusion via
   * `excludeIds`. The bridge does the final pick (weighted random or
   * top-N) over the returned slice.
   *
   * Stage-1 NodeBook impl returns nodes sorted by weight desc; stage-2
   * gRPC impl returns whatever the daemon's `Select` RPC returns.
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
   * Stage-1 carries the full NodeBook NodeEntry here so callers reaching
   * for circuit state or cached quotes can narrow via metadata. Stage-2
   * gRPC impl populates with daemon-reported fields (lat/lon, region,
   * operator address, signature_status).
   */
  metadata?: unknown;
}
