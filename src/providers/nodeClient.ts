import { z } from 'zod';
import type { Quote } from '../types/node.js';
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from '../types/openai.js';
import {
  EmbeddingsRequestSchema,
  EmbeddingsResponseSchema,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
} from '../types/embeddings.js';
import {
  ImagesGenerationRequestSchema,
  ImagesResponseSchema,
  type ImagesGenerationRequest,
  type ImagesResponse,
} from '../types/images.js';
import { type SpeechRequest } from '../types/speech.js';

// NodeHealthResponseSchema matches openai-worker-node `/health` output
// as of worker commit 2b5cd2a. Worker emits:
//   { status: "ok"|"degraded", protocol_version: int,
//     max_concurrent: int, inflight: int }
// `detail` is kept optional for forward-compat with a future error shape.
export const NodeHealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  protocol_version: z.number().int().nonnegative(),
  max_concurrent: z.number().int().nonnegative(),
  inflight: z.number().int().nonnegative(),
  detail: z.string().optional(),
});
export type NodeHealthResponse = z.infer<typeof NodeHealthResponseSchema>;

// Decimal wei: "123456789" → 123456789n. Accepts numeric + decimal-string.
const DecimalWeiSchema = z
  .union([
    z.string().regex(/^\d+$/, 'must be a non-negative base-10 integer string'),
    z.number().int().nonnegative(),
  ])
  .transform((v) => BigInt(v));

// Hex wei: "0x..." → bigint via BigInt("0x..."). Accepts empty "0x" as 0n.
const HexBytesBigIntSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string')
  .transform((v) => (v === '0x' ? 0n : BigInt(v)));

// Hex bytes kept as a string (no bigint conversion) — used for fields
// the bridge treats as opaque identifiers rather than numeric values
// (seed, recipient, recipient_rand_hash, creation_round_block_hash).
const HexBytesStringSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string');

// Worker's /quote emits snake_case field names and 0x-prefixed hex for
// byte-typed fields. Post-0018 worker wire format; see
// openai-worker-node/internal/runtime/http/handlers.go `quoteJSON`.
const WireTicketExpirationParamsSchema = z.object({
  creation_round: z.number().int().nonnegative(),
  creation_round_block_hash: HexBytesStringSchema,
});

const WireTicketParamsSchema = z.object({
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  face_value_wei: HexBytesBigIntSchema,
  win_prob: HexBytesStringSchema,
  recipient_rand_hash: HexBytesStringSchema,
  seed: HexBytesStringSchema,
  expiration_block: HexBytesBigIntSchema,
  expiration_params: WireTicketExpirationParamsSchema,
});

// Per-model pricing — replaces the pre-0018 single priceInfo.
const WireModelPriceSchema = z.object({
  model: z.string().min(1),
  // Worker emits wei as a decimal string (see
  // payeedaemon.ModelPrice.PricePerWorkUnitWei).
  price_per_work_unit_wei: DecimalWeiSchema,
});

export const NodeQuoteResponseSchema = z.object({
  ticket_params: WireTicketParamsSchema,
  model_prices: z.array(WireModelPriceSchema).min(1),
});
export type NodeQuoteResponseWire = z.infer<typeof NodeQuoteResponseSchema>;

// NodeQuoteResponse is the domain-shaped value the bridge carries
// internally. Callers receive this from nodeClient.getQuote; the raw
// wire response is projected + enriched with bridge-local
// `lastRefreshedAt` / `expiresAt`.
export type NodeQuoteResponse = Quote;

// /capabilities payload. Mirrors openai-worker-node's
// capabilitiesHandler output. Used by phase-2 dynamic-discovery
// work; introduced here so schema + method land together.
const WireCapabilityModelSchema = z.object({
  model: z.string().min(1),
  price_per_work_unit_wei: DecimalWeiSchema,
});

const WireCapabilityEntrySchema = z.object({
  capability: z.string().regex(/^[a-z][a-z0-9]*:.+$/, 'capability must match <domain>:<identifier>'),
  work_unit: z.string().min(1),
  models: z.array(WireCapabilityModelSchema).min(1),
});

export const NodeCapabilitiesResponseSchema = z.object({
  protocol_version: z.number().int().nonnegative(),
  capabilities: z.array(WireCapabilityEntrySchema),
});
export type NodeCapabilitiesResponse = z.infer<typeof NodeCapabilitiesResponseSchema>;

// Batched /quotes response: one entry per configured capability.
const WireQuoteEntrySchema = z.object({
  capability: z.string().min(1),
  quote: NodeQuoteResponseSchema,
});
export const NodeQuotesResponseSchema = z.object({
  quotes: z.array(WireQuoteEntrySchema),
});
export type NodeQuotesResponse = z.infer<typeof NodeQuotesResponseSchema>;

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

export interface StreamChatCompletionInput {
  url: string;
  body: ChatCompletionRequest;
  paymentHeaderB64: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface RawSseEvent {
  data: string;
}

export interface StreamChatCompletionResult {
  status: number;
  events: AsyncIterable<RawSseEvent> | null;
  rawErrorBody: string | null;
}

export interface EmbeddingsCallInput {
  url: string;
  body: EmbeddingsRequest;
  paymentHeaderB64: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface EmbeddingsCallResult {
  status: number;
  response: EmbeddingsResponse | null;
  rawBody: string;
}

export interface ImageGenerationCallInput {
  url: string;
  body: ImagesGenerationRequest;
  paymentHeaderB64: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ImageGenerationCallResult {
  status: number;
  response: ImagesResponse | null;
  rawBody: string;
}

export interface SpeechCallInput {
  url: string;
  body: SpeechRequest;
  paymentHeaderB64: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SpeechCallResult {
  status: number;
  // stream is non-null on success (status 2xx). On error, rawErrorBody
  // carries the upstream response body so the caller can attach it to
  // the bridge's error envelope.
  stream: ReadableStream<Uint8Array> | null;
  contentType: string | null;
  rawErrorBody: string | null;
}

export interface TranscriptionCallInput {
  url: string;
  // Multipart body the bridge already received from its customer; we
  // forward it verbatim (boundary + all fields) to the worker so the
  // file payload is never re-encoded or buffered into bridge memory.
  body: ReadableStream<Uint8Array>;
  contentType: string;
  paymentHeaderB64: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TranscriptionCallResult {
  status: number;
  contentType: string | null;
  bodyText: string;
  // reportedDurationSeconds is read from the
  // `x-livepeer-audio-duration-seconds` response header. Null when
  // the header is missing or unparseable — the handler refunds in that
  // case (see /v1/audio/transcriptions handler).
  reportedDurationSeconds: number | null;
  rawErrorBody: string | null;
}

export {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  EmbeddingsRequestSchema,
  EmbeddingsResponseSchema,
  ImagesGenerationRequestSchema,
  ImagesResponseSchema,
};

export interface GetQuoteInput {
  url: string;
  sender: string; // 0x-prefixed 40-hex; validated by caller config
  capability: string; // e.g. "openai:/v1/chat/completions"
  timeoutMs: number;
}

export interface GetQuotesInput {
  url: string;
  sender: string;
  timeoutMs: number;
}

export interface NodeClient {
  getHealth(url: string, timeoutMs: number): Promise<NodeHealthResponse>;
  getCapabilities(url: string, timeoutMs: number): Promise<NodeCapabilitiesResponse>;
  getQuote(input: GetQuoteInput): Promise<NodeQuoteResponse>;
  getQuotes(input: GetQuotesInput): Promise<NodeQuotesResponse>;
  createChatCompletion(input: ChatCompletionCallInput): Promise<ChatCompletionCallResult>;
  streamChatCompletion(input: StreamChatCompletionInput): Promise<StreamChatCompletionResult>;
  createEmbeddings(input: EmbeddingsCallInput): Promise<EmbeddingsCallResult>;
  createImage(input: ImageGenerationCallInput): Promise<ImageGenerationCallResult>;
  createSpeech(input: SpeechCallInput): Promise<SpeechCallResult>;
  createTranscription(input: TranscriptionCallInput): Promise<TranscriptionCallResult>;
}
