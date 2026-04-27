import { describe, expect, it } from 'vitest';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  mapGrpcError,
  PayerDaemonError,
  PayerDaemonProtocolError,
  PayerDaemonUnavailableError,
} from './errors.js';

describe('mapGrpcError', () => {
  it('maps UNAVAILABLE to PayerDaemonUnavailableError', () => {
    const err = mapGrpcError({ code: GrpcStatus.UNAVAILABLE, message: 'connection refused' });
    expect(err).toBeInstanceOf(PayerDaemonUnavailableError);
    expect(err.code).toBe('payment_daemon_unavailable');
  });

  it('maps DEADLINE_EXCEEDED to PayerDaemonUnavailableError', () => {
    const err = mapGrpcError({ code: GrpcStatus.DEADLINE_EXCEEDED, message: 'deadline' });
    expect(err).toBeInstanceOf(PayerDaemonUnavailableError);
  });

  it('maps INVALID_ARGUMENT to PayerDaemonProtocolError', () => {
    const err = mapGrpcError({ code: GrpcStatus.INVALID_ARGUMENT, message: 'bad' });
    expect(err).toBeInstanceOf(PayerDaemonProtocolError);
    expect(err.code).toBe('internal');
  });

  it('maps FAILED_PRECONDITION to PayerDaemonProtocolError', () => {
    const err = mapGrpcError({ code: GrpcStatus.FAILED_PRECONDITION, message: 'bad' });
    expect(err).toBeInstanceOf(PayerDaemonProtocolError);
  });

  it('tags CANCELLED as PayerDaemonCancelledError', () => {
    const err = mapGrpcError({ code: GrpcStatus.CANCELLED, message: 'cancelled' });
    expect(err.name).toBe('PayerDaemonCancelledError');
    expect(err).toBeInstanceOf(PayerDaemonError);
  });

  it('falls back to generic PayerDaemonError for unmapped codes', () => {
    const err = mapGrpcError({ code: GrpcStatus.PERMISSION_DENIED, message: 'nope' });
    expect(err).toBeInstanceOf(PayerDaemonError);
    expect(err).not.toBeInstanceOf(PayerDaemonUnavailableError);
    expect(err).not.toBeInstanceOf(PayerDaemonProtocolError);
  });

  it('treats errors without a code as unavailable (socket-level)', () => {
    const err = mapGrpcError(new Error('ECONNREFUSED'));
    expect(err).toBeInstanceOf(PayerDaemonUnavailableError);
    expect(err.grpcCode).toBeNull();
  });
});
