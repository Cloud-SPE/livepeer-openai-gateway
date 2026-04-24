import type { NodeQuoteResponseWire } from '../nodeClient.js';
import type { Quote } from '../../types/node.js';

// TTL for how long a freshly-fetched Quote is considered usable by the
// payment pipeline. 60 s matches the worker's default refresh cadence
// plus a generous buffer. Phase 2 moves this to config.
const QUOTE_TTL_MS = 60_000;

/**
 * wireQuoteToDomain projects the worker's /quote JSON into the
 * bridge's domain `Quote`. The wire side uses snake_case + 0x-hex
 * byte fields; the bridge domain uses camelCase + bigints. Since
 * phase 1 still carries a single Quote.priceInfo per node, we pick
 * the first model_prices[] entry as the representative price.
 *
 * Over-charging is possible when a request actually routes to a
 * cheaper model on the same capability — phase 2's per-(capability,
 * model) NodeBook reshape fixes this.
 */
export function wireQuoteToDomain(wire: NodeQuoteResponseWire): Quote {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);
  const first = wire.model_prices[0];
  if (!first) {
    // Schema validation enforces model_prices.min(1); this branch is
    // unreachable but keeps the type narrowing explicit.
    throw new Error('wireQuoteToDomain: model_prices is empty');
  }
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
      pricePerUnitWei: first.price_per_work_unit_wei,
      pixelsPerUnit: 1n,
    },
    lastRefreshedAt: now,
    expiresAt,
  };
}
