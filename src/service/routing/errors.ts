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
