import type { NodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import type { NodeCapability } from '@cloudspe/livepeer-openai-gateway-core/types/node.js';
import type { ServiceRegistryClient } from '../../providers/serviceRegistry.js';

export interface SelectedNodeRoute {
  nodeId: string;
  url: string;
  recipientEthAddress: string;
  pricePerWorkUnitWei: bigint;
  workUnit: string;
  offering: string;
  capability: string;
}

export async function selectRoute(
  deps: {
    serviceRegistry: ServiceRegistryClient;
    nodeIndex: NodeIndex;
  },
  query: {
    capability: NodeCapability;
    offering: string;
    tier: string;
  },
): Promise<SelectedNodeRoute> {
  const route = await deps.serviceRegistry.select(query);
  return {
    nodeId: deps.nodeIndex.findIdByUrl(route.workerUrl) ?? route.ethAddress,
    url: route.workerUrl,
    recipientEthAddress: route.ethAddress,
    pricePerWorkUnitWei: route.pricePerWorkUnitWei,
    workUnit: route.workUnit,
    offering: route.offering,
    capability: route.capability,
  };
}
