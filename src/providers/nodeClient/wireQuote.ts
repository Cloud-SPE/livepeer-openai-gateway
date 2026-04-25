import type { NodeQuoteResponseWire } from '../nodeClient.js';
import type { Quote } from '../../types/node.js';

// TTL for how long a freshly-fetched Quote is considered usable by the
// payment pipeline. 60 s matches the worker's default refresh cadence
// plus a generous buffer. Phase 2 moves this to config.
const QUOTE_TTL_MS = 60_000;

/**
 * wireQuoteToDomain projects the worker's /quote JSON into the
 * bridge's domain `Quote`. The wire side uses snake_case + 0x-hex
 * byte fields; the bridge domain uses camelCase + bigints.
 *
 * Quote.priceInfo carries the MAX model price on this capability —
 * the worker uses that price to size TicketParams.face_value, so the
 * representative wei figure has to match. Quote.modelPrices keeps
 * the full per-model breakdown; routes that bill at a specific model
 * (chat, embeddings, images-edits, etc.) read modelPrices[model]
 * for exact pricing, falling back to priceInfo for the
 * representative max if the model isn't enumerated.
 */
export function wireQuoteToDomain(wire: NodeQuoteResponseWire): Quote {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);
  if (wire.model_prices.length === 0) {
    // Schema validation enforces model_prices.min(1); guard kept so
    // type narrowing on `max` is explicit.
    throw new Error('wireQuoteToDomain: model_prices is empty');
  }
  const max = wire.model_prices.reduce((acc, m) =>
    m.price_per_work_unit_wei > acc.price_per_work_unit_wei ? m : acc,
  );
  return {
    ticketParams: {
      recipient: wire.ticket_params.recipient as `0x${string}`,
      faceValueWei: wire.ticket_params.face_value_wei,
      winProb: wire.ticket_params.win_prob,
      recipientRandHash: wire.ticket_params.recipient_rand_hash,
      seed: wire.ticket_params.seed,
      expirationBlock: wire.ticket_params.expiration_block,
      expirationParams: {
        creationRound: BigInt(wire.ticket_params.expiration_params.creation_round),
        creationRoundBlockHash: wire.ticket_params.expiration_params.creation_round_block_hash,
      },
    },
    priceInfo: {
      pricePerUnitWei: max.price_per_work_unit_wei,
      pixelsPerUnit: 1n,
    },
    modelPrices: Object.fromEntries(
      wire.model_prices.map((m) => [m.model, m.price_per_work_unit_wei]),
    ),
    lastRefreshedAt: now,
    expiresAt,
  };
}
