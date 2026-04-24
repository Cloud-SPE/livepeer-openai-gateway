import { ZodError } from 'zod';
import { AuthError } from '../../service/auth/errors.js';
import {
  BalanceInsufficientError,
  BillingError,
  QuotaExceededError,
} from '../../service/billing/errors.js';
import { NoHealthyNodesError, NodesError } from '../../service/nodes/errors.js';
import {
  PayerDaemonError,
  PayerDaemonUnavailableError,
} from '../../providers/payerDaemon/errors.js';
import {
  PayerDaemonNotHealthyError,
  PaymentsError,
  QuoteExpiredError,
} from '../../service/payments/errors.js';
import { ModelNotFoundError, RoutingError } from '../../service/routing/errors.js';
import type { ErrorEnvelope } from '../../types/error.js';

export interface HttpError {
  status: number;
  envelope: ErrorEnvelope;
}

export function toHttpError(err: unknown): HttpError {
  if (err instanceof AuthError) {
    return {
      status: 401,
      envelope: {
        error: { code: 'invalid_api_key', type: err.name, message: err.message },
      },
    };
  }
  if (err instanceof BalanceInsufficientError) {
    return {
      status: 402,
      envelope: {
        error: { code: 'insufficient_quota', type: err.name, message: err.message },
      },
    };
  }
  if (err instanceof QuotaExceededError) {
    return {
      status: 429,
      envelope: {
        error: { code: 'insufficient_quota', type: err.name, message: err.message },
      },
    };
  }
  if (err instanceof ModelNotFoundError) {
    return {
      status: 404,
      envelope: {
        error: { code: 'model_not_found', type: err.name, message: err.message },
      },
    };
  }
  if (err instanceof NoHealthyNodesError) {
    return {
      status: 503,
      envelope: {
        error: { code: 'service_unavailable', type: err.name, message: err.message },
      },
    };
  }
  if (err instanceof PayerDaemonUnavailableError || err instanceof PayerDaemonNotHealthyError) {
    return {
      status: 503,
      envelope: {
        error: { code: 'service_unavailable', type: err.name, message: err.message },
      },
    };
  }
  if (err instanceof QuoteExpiredError) {
    return {
      status: 503,
      envelope: {
        error: { code: 'service_unavailable', type: err.name, message: err.message },
      },
    };
  }
  if (err instanceof UpstreamNodeError || err instanceof MissingUsageError) {
    return {
      status: 503,
      envelope: {
        error: { code: 'service_unavailable', type: err.name, message: err.message },
      },
    };
  }
  if (err instanceof PaymentsError || err instanceof PayerDaemonError) {
    return {
      status: 500,
      envelope: {
        error: { code: 'internal_error', type: err.name, message: err.message },
      },
    };
  }
  if (err instanceof RoutingError || err instanceof NodesError || err instanceof BillingError) {
    return {
      status: 500,
      envelope: {
        error: { code: 'internal_error', type: err.name, message: err.message },
      },
    };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      envelope: {
        error: {
          code: 'invalid_request_error',
          type: 'InvalidRequestError',
          message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      },
    };
  }
  const message = err instanceof Error ? err.message : 'internal error';
  return {
    status: 500,
    envelope: {
      error: { code: 'internal_error', type: 'InternalError', message },
    },
  };
}

export class UpstreamNodeError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly status: number | null,
    public readonly detail: string,
  ) {
    super(`upstream node ${nodeId} failed (${status ?? 'no-status'}): ${detail}`);
    this.name = 'UpstreamNodeError';
  }
}

export class MissingUsageError extends Error {
  constructor(public readonly nodeId: string) {
    super(`upstream node ${nodeId} returned no usage — cannot bill`);
    this.name = 'MissingUsageError';
  }
}
