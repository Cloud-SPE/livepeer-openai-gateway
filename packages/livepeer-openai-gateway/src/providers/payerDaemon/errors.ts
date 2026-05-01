/* v8 ignore file */

import { status as GrpcStatus } from '@grpc/grpc-js';
import type { ErrorCode } from '@cloudspe/livepeer-openai-gateway-core/types/error.js';

export class PayerDaemonError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly grpcCode: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'PayerDaemonError';
  }
}

export class PayerDaemonUnavailableError extends PayerDaemonError {
  constructor(grpcCode: number | null, detail: string) {
    super('payment_daemon_unavailable', grpcCode, `PayerDaemon unavailable: ${detail}`);
    this.name = 'PayerDaemonUnavailableError';
  }
}

export class PayerDaemonProtocolError extends PayerDaemonError {
  constructor(grpcCode: number, detail: string) {
    super('internal', grpcCode, `PayerDaemon protocol error: ${detail}`);
    this.name = 'PayerDaemonProtocolError';
  }
}

interface ServiceError {
  code?: number;
  message?: string;
  details?: string;
}

export function mapGrpcError(err: unknown): PayerDaemonError {
  const se = err as ServiceError | undefined;
  const code = typeof se?.code === 'number' ? se.code : null;
  const detail = se?.details ?? se?.message ?? String(err);

  if (code === null) {
    return new PayerDaemonUnavailableError(null, detail);
  }
  if (code === GrpcStatus.UNAVAILABLE || code === GrpcStatus.DEADLINE_EXCEEDED) {
    return new PayerDaemonUnavailableError(code, detail);
  }
  if (code === GrpcStatus.INVALID_ARGUMENT || code === GrpcStatus.FAILED_PRECONDITION) {
    return new PayerDaemonProtocolError(code, detail);
  }
  if (code === GrpcStatus.CANCELLED) {
    const out = new PayerDaemonError('internal', code, `PayerDaemon call cancelled: ${detail}`);
    out.name = 'PayerDaemonCancelledError';
    return out;
  }
  return new PayerDaemonError('internal', code, `PayerDaemon error (code=${code}): ${detail}`);
}
