import { z } from 'zod';
import type { Quote } from '../types/node.js';
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from '../types/openai.js';

export const NodeHealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  models: z.array(z.string()).default([]),
  detail: z.string().optional(),
});
export type NodeHealthResponse = z.infer<typeof NodeHealthResponseSchema>;

const BigIntStringSchema = z
  .union([
    z.string().regex(/^\d+$/, 'must be a non-negative base-10 integer string'),
    z.number().int().nonnegative(),
  ])
  .transform((v) => BigInt(v));

const WireTicketParamsSchema = z.object({
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  faceValueWei: BigIntStringSchema,
  winProb: z.string().min(1),
  seed: z.string().min(1),
  expirationBlock: BigIntStringSchema,
  expirationParamsHash: z.string().min(1),
});

const WirePriceInfoSchema = z.object({
  pricePerUnitWei: BigIntStringSchema,
  pixelsPerUnit: BigIntStringSchema.refine((v) => v > 0n, 'pixelsPerUnit must be > 0'),
});

export const NodeQuoteResponseSchema = z.object({
  ticketParams: WireTicketParamsSchema,
  priceInfo: WirePriceInfoSchema,
  lastRefreshedAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
});
export type NodeQuoteResponse = Quote;

export interface ChatCompletionCallInput {
  url: string;
  body: ChatCompletionRequest;
  paymentHeaderB64: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ChatCompletionCallResult {
  status: number;
  response: ChatCompletionResponse | null;
  rawBody: string;
}

export { ChatCompletionRequestSchema, ChatCompletionResponseSchema };

export interface NodeClient {
  getHealth(url: string, timeoutMs: number): Promise<NodeHealthResponse>;
  getQuote(url: string, timeoutMs: number): Promise<NodeQuoteResponse>;
  createChatCompletion(input: ChatCompletionCallInput): Promise<ChatCompletionCallResult>;
}
