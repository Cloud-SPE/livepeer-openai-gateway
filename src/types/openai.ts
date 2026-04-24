import { z } from 'zod';
import { ModelIdSchema } from './pricing.js';

export const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool', 'developer']);
export type Role = z.infer<typeof RoleSchema>;

export const MessageSchema = z.object({
  role: RoleSchema,
  content: z.string(),
  name: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const UsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const StreamOptionsSchema = z.object({
  include_usage: z.boolean().optional(),
});
export type StreamOptions = z.infer<typeof StreamOptionsSchema>;

export const ChatCompletionRequestSchema = z.object({
  model: ModelIdSchema,
  messages: z.array(MessageSchema).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  stream_options: StreamOptionsSchema.optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  user: z.string().optional(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export const FinishReasonSchema = z.enum(['stop', 'length', 'content_filter', 'tool_calls']);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const ChatCompletionChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  message: MessageSchema,
  finish_reason: FinishReasonSchema.nullable(),
});
export type ChatCompletionChoice = z.infer<typeof ChatCompletionChoiceSchema>;

export const ChatCompletionResponseSchema = z.object({
  id: z.string().min(1),
  object: z.literal('chat.completion'),
  created: z.number().int().nonnegative(),
  model: ModelIdSchema,
  choices: z.array(ChatCompletionChoiceSchema).min(1),
  usage: UsageSchema,
});
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;

export const ChatCompletionChunkDeltaSchema = z.object({
  role: RoleSchema.optional(),
  content: z.string().optional(),
});
export type ChatCompletionChunkDelta = z.infer<typeof ChatCompletionChunkDeltaSchema>;

export const ChatCompletionChunkChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  delta: ChatCompletionChunkDeltaSchema,
  finish_reason: FinishReasonSchema.nullable(),
});
export type ChatCompletionChunkChoice = z.infer<typeof ChatCompletionChunkChoiceSchema>;

export const ChatCompletionChunkSchema = z.object({
  id: z.string().min(1),
  object: z.literal('chat.completion.chunk'),
  created: z.number().int().nonnegative(),
  model: ModelIdSchema,
  choices: z.array(ChatCompletionChunkChoiceSchema),
  usage: UsageSchema.nullish(),
});
export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>;
