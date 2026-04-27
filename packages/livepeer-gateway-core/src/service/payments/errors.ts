import type { ErrorCode } from '../../types/error.js';

export class PaymentsError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentsError';
  }
}

export class QuoteExpiredError extends PaymentsError {
  constructor(public readonly nodeId: string) {
    super('upstream_unavailable', `quote for node ${nodeId} has expired`);
    this.name = 'QuoteExpiredError';
  }
}

export class PayerDaemonNotHealthyError extends PaymentsError {
  constructor() {
    super('payment_daemon_unavailable', 'payer daemon is not healthy; failing closed');
    this.name = 'PayerDaemonNotHealthyError';
  }
}
