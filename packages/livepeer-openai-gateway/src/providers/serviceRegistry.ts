import type { NodeCapability } from '@cloudspe/livepeer-openai-gateway-core/types/node.js';

export interface SelectQuery {
  capability: NodeCapability;
  offering: string;
  tier?: string;
}

export interface NodeRef {
  id: string;
  url: string;
  capabilities: NodeCapability[];
  weight?: number;
  metadata?: unknown;
}

export interface SelectedRoute {
  workerUrl: string;
  ethAddress: string;
  capability: string;
  offering: string;
  pricePerWorkUnitWei: bigint;
  workUnit: string;
  extraJson?: Uint8Array;
  constraintsJson?: Uint8Array;
}

export interface ServiceRegistryClient {
  select(query: SelectQuery): Promise<SelectedRoute>;
  listKnown(capability?: NodeCapability): Promise<NodeRef[]>;
}
