import type { ErrorCode } from '../../types/error.js';

export class AuthError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class MalformedAuthorizationError extends AuthError {
  constructor(public readonly detail: string) {
    super('authentication_failed', `malformed Authorization header: ${detail}`);
    this.name = 'MalformedAuthorizationError';
  }
}

export class InvalidApiKeyError extends AuthError {
  constructor() {
    super('authentication_failed', 'api key not recognized or revoked');
    this.name = 'InvalidApiKeyError';
  }
}

export class AccountSuspendedError extends AuthError {
  constructor(public readonly customerId: string) {
    super('authentication_failed', `account ${customerId} is suspended`);
    this.name = 'AccountSuspendedError';
  }
}

export class AccountClosedError extends AuthError {
  constructor(public readonly customerId: string) {
    super('authentication_failed', `account ${customerId} is closed`);
    this.name = 'AccountClosedError';
  }
}
