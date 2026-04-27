import { z } from 'zod';
import { ModelIdSchema } from './pricing.js';

export const EmbeddingsInputSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);
export type EmbeddingsInput = z.infer<typeof EmbeddingsInputSchema>;

export const EmbeddingsEncodingFormatSchema = z.enum(['float', 'base64']);
export type EmbeddingsEncodingFormat = z.infer<typeof EmbeddingsEncodingFormatSchema>;

export const EmbeddingsRequestSchema = z.object({
  model: ModelIdSchema,
  input: EmbeddingsInputSchema,
  encoding_format: EmbeddingsEncodingFormatSchema.optional(),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
});
export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>;

export const EmbeddingsUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export type EmbeddingsUsage = z.infer<typeof EmbeddingsUsageSchema>;

export const EmbeddingSchema = z.object({
  object: z.literal('embedding'),
  index: z.number().int().nonnegative(),
  embedding: z.union([z.array(z.number()), z.string()]),
});
export type Embedding = z.infer<typeof EmbeddingSchema>;

export const EmbeddingsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(EmbeddingSchema).min(1),
  model: ModelIdSchema,
  usage: EmbeddingsUsageSchema,
});
export type EmbeddingsResponse = z.infer<typeof EmbeddingsResponseSchema>;

export function normalizeEmbeddingsInput(input: EmbeddingsInput): string[] {
  return Array.isArray(input) ? input : [input];
}
