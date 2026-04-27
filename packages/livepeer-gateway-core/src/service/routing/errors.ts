import type { ErrorCode } from '../../types/error.js';

export class RoutingError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

export class ModelNotFoundError extends RoutingError {
  constructor(public readonly model: string) {
    super('model_unavailable', `model not found in rate card: ${model}`);
    this.name = 'ModelNotFoundError';
  }
}

/**
 * Base class for node-pool errors surfaced through the HTTP error
 * mapper. Distinct from RoutingError so the mapper can render
 * "no healthy nodes" with a different status code than rate-card
 * misses.
 */
export class NodesError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NodesError';
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
