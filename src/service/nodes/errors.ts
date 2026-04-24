import type { ErrorCode } from '../../types/error.js';
import type { EthAddressChange } from '../../config/nodes.js';

export class NodesError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NodesError';
  }
}

export class EthAddressChangedError extends NodesError {
  constructor(public readonly changes: EthAddressChange[]) {
    super(
      'internal',
      `eth_address change rejected for nodes: ${changes
        .map((c) => `${c.nodeId} (${c.oldAddress} → ${c.newAddress})`)
        .join(', ')}`,
    );
    this.name = 'EthAddressChangedError';
  }
}

export class NoHealthyNodesError extends NodesError {
  constructor(
    public readonly model: string,
    public readonly tier: 'free' | 'prepaid',
  ) {
    super('model_unavailable', `no healthy nodes for model=${model} tier=${tier}`);
    this.name = 'NoHealthyNodesError';
  }
}
