import type { ErrorCode } from '../../types/error.js';

export class BillingError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

export class BalanceInsufficientError extends BillingError {
  constructor(
    public readonly availableCents: bigint,
    public readonly requestedCents: bigint,
  ) {
    super('balance_insufficient', `balance insufficient: ${availableCents} < ${requestedCents}`);
    this.name = 'BalanceInsufficientError';
  }
}

export class QuotaExceededError extends BillingError {
  constructor(
    public readonly availableTokens: bigint,
    public readonly requestedTokens: bigint,
  ) {
    super('quota_exceeded', `quota exceeded: ${availableTokens} < ${requestedTokens}`);
    this.name = 'QuotaExceededError';
  }
}

export class ReservationNotOpenError extends BillingError {
  constructor(public readonly reservationId: string) {
    super('internal', `reservation ${reservationId} is not in state=open`);
    this.name = 'ReservationNotOpenError';
  }
}

export class CustomerNotFoundError extends BillingError {
  constructor(public readonly customerId: string) {
    super('internal', `customer ${customerId} not found`);
    this.name = 'CustomerNotFoundError';
  }
}

export class TierMismatchError extends BillingError {
  constructor(
    public readonly customerId: string,
    public readonly expected: 'free' | 'prepaid',
    public readonly actual: 'free' | 'prepaid',
  ) {
    super('internal', `tier mismatch for ${customerId}: expected ${expected}, got ${actual}`);
    this.name = 'TierMismatchError';
  }
}
