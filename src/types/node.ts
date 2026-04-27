import { z } from 'zod';

export const NodeIdSchema = z.string().min(1).max(64);
export type NodeId = z.infer<typeof NodeIdSchema>;

export const EthAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 40-char hex string');
export type EthAddress = z.infer<typeof EthAddressSchema>;

export const NodeCapabilitySchema = z.enum([
  'chat',
  'embeddings',
  'images',
  'imagesEdits',
  'speech',
  'transcriptions',
]);
export type NodeCapability = z.infer<typeof NodeCapabilitySchema>;

// TicketExpirationParamsSchema mirrors the library's
// livepeer.payments.v1.TicketExpirationParams. Both fields are
// required for correct ticket hashing on the receiver side — zero or
// empty values produce hashes that won't match what the worker
// computes, causing ProcessPayment to reject the ticket.
export const TicketExpirationParamsSchema = z.object({
  creationRound: z.bigint().nonnegative(),
  creationRoundBlockHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string'),
});
export type TicketExpirationParams = z.infer<typeof TicketExpirationParamsSchema>;

// TicketParamsSchema is the bridge's domain projection of the
// library's livepeer.payments.v1.TicketParams. All seven fields are
// carried so the PayerDaemon can sign tickets that the worker's
// PayeeDaemon will accept. `recipientRandHash` is the 32-byte
// commitment; the worker re-derives it via HMAC and compares against
// the ticket — this and `expirationParams` MUST come from the
// worker's /quote response verbatim.
export const TicketParamsSchema = z.object({
  recipient: EthAddressSchema,
  faceValueWei: z.bigint().nonnegative(),
  winProb: z.string().min(1),
  recipientRandHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string'),
  seed: z.string().min(1),
  expirationBlock: z.bigint().nonnegative(),
  expirationParams: TicketExpirationParamsSchema,
});
export type TicketParams = z.infer<typeof TicketParamsSchema>;

export const PriceInfoSchema = z.object({
  pricePerUnitWei: z.bigint().nonnegative(),
  pixelsPerUnit: z.bigint().positive(),
});
export type PriceInfo = z.infer<typeof PriceInfoSchema>;

// QuoteSchema captures the bridge's per-capability projection of the
// worker's /quote response. priceInfo is the representative max-price
// (used to size the TicketParams face value); modelPrices carries the
// per-model breakdown the worker emits in `model_prices[]`. Callers
// that need exact per-model wei look up modelPrices[modelId] when
// available, else fall back to priceInfo.
export const QuoteSchema = z.object({
  ticketParams: TicketParamsSchema,
  priceInfo: PriceInfoSchema,
  modelPrices: z.record(z.string(), z.bigint().nonnegative()),
  lastRefreshedAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
});
export type Quote = z.infer<typeof QuoteSchema>;

