import type { NodeCapability } from '@cloudspe/livepeer-openai-gateway-core/types/node.js';
import type { ServiceRegistryClient, SelectedRoute } from '../../../providers/serviceRegistry.js';
import type { PayerDaemonClient } from '../../../providers/payerDaemon.js';

export interface FakeRouteOptions {
  id: string;
  url: string;
  capability: NodeCapability;
  offering: string;
  ethAddress?: string;
  pricePerWorkUnitWei?: bigint;
  workUnit?: string;
  capabilities?: NodeCapability[];
}

export function createFakeV3ServiceRegistry(
  opts: FakeRouteOptions,
): ServiceRegistryClient & { isHealthy(): boolean } {
  const route: SelectedRoute = {
    workerUrl: opts.url,
    ethAddress: opts.ethAddress ?? '0x1111111111111111111111111111111111111111',
    capability: capabilityName(opts.capability),
    offering: opts.offering,
    pricePerWorkUnitWei: opts.pricePerWorkUnitWei ?? 1n,
    workUnit: opts.workUnit ?? 'request',
  };

  return {
    async select(query) {
      if (query.capability !== opts.capability || query.offering !== opts.offering) {
        throw new Error(
          `not_found: no route for capability="${query.capability}" offering="${query.offering}"`,
        );
      }
      return route;
    },
    async listKnown(capability) {
      if (capability && capability !== opts.capability) return [];
      return [
        {
          id: opts.id,
          url: opts.url,
          capabilities: opts.capabilities ?? [opts.capability],
          weight: 100,
        },
      ];
    },
    isHealthy() {
      return true;
    },
  };
}

export function createFakeV3PayerDaemon(
  overrides: Partial<PayerDaemonClient> = {},
): PayerDaemonClient {
  return {
    async createPayment() {
      return {
        paymentBytes: new Uint8Array([1, 2]),
        ticketsCreated: 1,
        expectedValueWei: 5n,
      };
    },
    async getDepositInfo() {
      return { depositWei: 1_000_000n, reserveWei: 500_000n, withdrawRound: 0n };
    },
    isHealthy() {
      return true;
    },
    startHealthLoop() {
      /* noop */
    },
    stopHealthLoop() {
      /* noop */
    },
    async close() {
      /* noop */
    },
    ...overrides,
  };
}

function capabilityName(capability: NodeCapability): string {
  switch (capability) {
    case 'chat':
      return 'openai:/v1/chat/completions';
    case 'embeddings':
      return 'openai:/v1/embeddings';
    case 'images':
      return 'openai:/v1/images/generations';
    case 'imagesEdits':
      return 'openai:/v1/images/edits';
    case 'speech':
      return 'openai:/v1/audio/speech';
    case 'transcriptions':
      return 'openai:/v1/audio/transcriptions';
  }
}
