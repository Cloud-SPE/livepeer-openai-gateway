import { z } from 'zod';
import { ModelIdSchema } from './pricing.js';

// Matches OpenAI's `/v1/audio/transcriptions` upper bound.
export const TRANSCRIPTIONS_MAX_FILE_BYTES = 25 * 1024 * 1024;

// `x-livepeer-audio-duration-seconds` is the source of truth for billing
// duration across every response_format. The worker contract obligates
// every successful transcription response to carry it; bridge fails the
// commit (refund + 503) when it's missing or unparseable.
export const TRANSCRIPTIONS_DURATION_HEADER = 'x-livepeer-audio-duration-seconds';

export const TranscriptionsResponseFormatSchema = z.enum([
  'json',
  'text',
  'srt',
  'verbose_json',
  'vtt',
]);
export type TranscriptionsResponseFormat = z.infer<typeof TranscriptionsResponseFormatSchema>;

// The request shape lives in multipart/form-data, not JSON. The schema
// below captures the form fields the bridge actually inspects (model
// for routing; the rest are forwarded verbatim).
export const TranscriptionsFormFieldsSchema = z.object({
  model: ModelIdSchema,
  prompt: z.string().optional(),
  response_format: TranscriptionsResponseFormatSchema.optional(),
  temperature: z.coerce.number().min(0).max(1).optional(),
  language: z.string().min(2).max(8).optional(),
});
export type TranscriptionsFormFields = z.infer<typeof TranscriptionsFormFieldsSchema>;

// `verbose_json` carries duration in the body for backwards-compat,
// but bridge reads only the response header — duration in the body is
// optional.
export const TranscriptionsJsonResponseSchema = z.object({
  text: z.string(),
});
export type TranscriptionsJsonResponse = z.infer<typeof TranscriptionsJsonResponseSchema>;

export const TranscriptionsVerboseJsonResponseSchema = z.object({
  task: z.string().optional(),
  language: z.string().optional(),
  duration: z.number().nonnegative().optional(),
  text: z.string(),
  segments: z.array(z.unknown()).optional(),
});
export type TranscriptionsVerboseJsonResponse = z.infer<
  typeof TranscriptionsVerboseJsonResponseSchema
>;
