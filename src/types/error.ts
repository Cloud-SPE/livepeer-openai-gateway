import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'invalid_request',
  'authentication_failed',
  'quota_exceeded',
  'balance_insufficient',
  'rate_limited',
  'model_unavailable',
  'upstream_unavailable',
  'payment_daemon_unavailable',
  'stream_terminated_early',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    type: z.string().min(1),
    param: z.string().nullish(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
