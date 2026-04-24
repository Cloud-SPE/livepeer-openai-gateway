import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { InvalidApiKeyError } from '../../service/auth/errors.js';
import { BalanceInsufficientError, QuotaExceededError } from '../../service/billing/errors.js';
import { ModelNotFoundError } from '../../service/routing/errors.js';
import { NoHealthyNodesError } from '../../service/nodes/errors.js';
import { PayerDaemonUnavailableError } from '../../providers/payerDaemon/errors.js';
import { toHttpError, MissingUsageError, UpstreamNodeError } from './errors.js';

describe('toHttpError', () => {
  it('maps AuthError subclasses to 401 with invalid_api_key', () => {
    const h = toHttpError(new InvalidApiKeyError());
    expect(h.status).toBe(401);
    expect(h.envelope.error.code).toBe('invalid_api_key');
  });

  it('maps BalanceInsufficientError to 402 insufficient_quota', () => {
    const h = toHttpError(new BalanceInsufficientError(0n, 10n));
    expect(h.status).toBe(402);
    expect(h.envelope.error.code).toBe('insufficient_quota');
  });

  it('maps QuotaExceededError to 429 insufficient_quota', () => {
    const h = toHttpError(new QuotaExceededError(0n, 10n));
    expect(h.status).toBe(429);
  });

  it('maps ModelNotFoundError to 404 model_not_found', () => {
    const h = toHttpError(new ModelNotFoundError('x'));
    expect(h.status).toBe(404);
    expect(h.envelope.error.code).toBe('model_not_found');
  });

  it('maps NoHealthyNodesError to 503 service_unavailable', () => {
    const h = toHttpError(new NoHealthyNodesError('m', 'prepaid'));
    expect(h.status).toBe(503);
    expect(h.envelope.error.code).toBe('service_unavailable');
  });

  it('maps PayerDaemonUnavailableError to 503', () => {
    const h = toHttpError(new PayerDaemonUnavailableError(null, 'down'));
    expect(h.status).toBe(503);
  });

  it('maps ZodError to 400 invalid_request_error with path-tagged message', () => {
    const schema = z.object({ a: z.string() });
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    const h = toHttpError((parsed as { success: false; error: ZodError }).error);
    expect(h.status).toBe(400);
    expect(h.envelope.error.code).toBe('invalid_request_error');
    expect(h.envelope.error.message).toContain('a');
  });

  it('falls back to 500 internal_error for unknown errors', () => {
    const h = toHttpError(new Error('kaboom'));
    expect(h.status).toBe(500);
    expect(h.envelope.error.code).toBe('internal_error');
    expect(h.envelope.error.message).toBe('kaboom');
  });

  it('carries structured fields on UpstreamNodeError and MissingUsageError', () => {
    const up = new UpstreamNodeError('node-a', 500, 'boom');
    expect(up.nodeId).toBe('node-a');
    expect(up.status).toBe(500);

    const mu = new MissingUsageError('node-b');
    expect(mu.nodeId).toBe('node-b');
  });
});
