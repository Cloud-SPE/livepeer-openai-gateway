---
title: Pricing model (rate card + margin policy)
status: accepted
last-reviewed: 2026-04-24
---

# Pricing model

The bridge prices three distinct endpoint families with three distinct rate structures:

- **Chat** (`/v1/chat/completions`) — tier-based. Models are grouped into tiers; rates price tiers, not individual models. Keeps the customer-facing surface stable when new models are added or swapped.
- **Embeddings** (`/v1/embeddings`) — model-keyed. Embedding models are not swappable (vector dimensions differ), so tier abstraction adds no value.
- **Images** (`/v1/images/generations`) — model × size × quality keyed. Per-image pricing is the industry standard; there is no token dimension.

## Chat rate card (v1 starter, monitor and adjust)

| Tier         | Input $ / 1M tokens | Output $ / 1M tokens | Target model class |
| ------------ | ------------------- | -------------------- | ------------------ |
| **Starter**  | $0.20               | $0.60                | small (7B–13B)     |
| **Standard** | $1.00               | $3.00                | medium (~70B)      |
| **Pro**      | $3.00               | $10.00               | large (frontier)   |

Competitive reference points (late-2025 / early-2026):

- Starter vs. GPT-4o-mini ($0.15 / $0.60); Groq Llama 70B ($0.59 / $0.79).
- Standard vs. Claude Haiku ($0.80 / $4.00).
- Pro vs. Claude Sonnet ($3.00 / $15.00); GPT-4o ($2.50 / $10.00).

Free tier consumes against the **Starter** rate for internal cost accounting (quota-capped at 100K tokens / month).

## Embeddings rate card (v1 starter)

Embeddings are priced per model, input-tokens only. Free tier is not available for embeddings in v1.

| Model                      | Input $ / 1M tokens | Notes                                    |
| -------------------------- | ------------------- | ---------------------------------------- |
| `text-embedding-3-small`   | $0.025              | vs. OpenAI $0.02 — 25% premium           |
| `text-embedding-3-large`   | $0.150              | vs. OpenAI $0.13 — 15% premium           |
| `text-embedding-bge-m3`    | $0.020              | open-source, smaller margin target       |

Rationale: a modest premium over OpenAI reflects the probabilistic-micropayment overhead and leaves headroom if ETH/USD swings widen node costs. Adjust per the margin policy below.

## Images rate card (v1 starter)

Images are priced per `(model, size, quality)`. The customer pays `n × usdPerImage` for a request that returns `n` images.

| Model     | Size       | Quality  | $ / image | Reference                    |
| --------- | ---------- | -------- | --------- | ---------------------------- |
| `dall-e-3` | 1024×1024  | standard | $0.050    | OpenAI $0.040 — 25% premium  |
| `dall-e-3` | 1024×1024  | hd       | $0.090    | OpenAI $0.080 — 12.5% premium |
| `dall-e-3` | 1024×1792  | standard | $0.090    | OpenAI $0.080 — 12.5% premium |
| `dall-e-3` | 1024×1792  | hd       | $0.130    | OpenAI $0.120 — 8.3% premium |
| `dall-e-3` | 1792×1024  | standard | $0.090    | OpenAI $0.080 — 12.5% premium |
| `dall-e-3` | 1792×1024  | hd       | $0.130    | OpenAI $0.120 — 8.3% premium |
| `sdxl`    | 1024×1024  | standard | $0.010    | open-source, volume play     |

**Partial delivery.** If the node returns fewer images than `n`, the customer is billed for `data.length × usdPerImage` and the delta is refunded. A zero-image response is a node contract violation (503 + full refund). See `docs/references/worker-node-contract.md §5.3`.

## Speech rate card (v1 starter)

Speech (TTS) is priced per character of `input`. Char count is exact at the bridge boundary, so the upfront reservation equals the final commit — no reconciliation drift.

| Model     | $ / 1M chars | Reference                          |
| --------- | ------------ | ---------------------------------- |
| `tts-1`    | $18.00      | OpenAI $15 — 20% premium           |
| `tts-1-hd` | $36.00      | OpenAI $30 — 20% premium           |
| `kokoro`   | $6.00       | open-source backend, smaller premium |

Free tier is not available for `/v1/audio/speech` in v1 (matches embeddings + images precedent).

## Transcriptions rate card (v1 starter)

Transcriptions (STT) is priced per minute of audio. The upfront reservation is sized at a worst-case bitrate (64 kbps) capped at 60 minutes; the actual commit uses the duration the node reports via the `x-livepeer-audio-duration-seconds` response header.

| Model       | $ / min   | Reference                   |
| ----------- | --------- | --------------------------- |
| `whisper-1`  | $0.0072  | OpenAI $0.006 — 20% premium |

If the worker omits the duration header on a 2xx response, the bridge returns `503 service_unavailable` and refunds the reservation in full (matches the universal "no usage = no bill" rule from 0007 — see `docs/references/worker-node-contract.md §7.3`).

Free tier is not available for `/v1/audio/transcriptions` in v1.

## Types

- `src/types/pricing.ts` exports five sibling rate card types, each with its own `version` + `effectiveAt`:
  - `ChatRateCard` — exactly three entries (`starter | standard | pro`), enforced by Zod.
  - `EmbeddingsRateCard` — list of `{ model, usdPerMillionTokens }` entries.
  - `ImagesRateCard` — list of `{ model, size, quality, usdPerImage }` entries.
  - `SpeechRateCard` — list of `{ model, usdPerMillionChars }` entries.
  - `TranscriptionsRateCard` — list of `{ model, usdPerMinute }` entries.
- `ModelTierMap` maps chat models to pricing tiers; embeddings, images, speech, and transcriptions do not use tiers (model-keyed rates).

## Margin math

### Chat

```
est_cost_usd    = max_tokens × customer_rate_per_token           # from rate card
est_cost_wei    = max_tokens × node_price_per_token              # from NodeBook quote
margin_percent  = (est_cost_usd − est_cost_wei × eth_usd) / est_cost_usd
```

`margin_percent` is tracked per `(tier, model, node)`.

### Embeddings

```
est_cost_usd    = input_tokens × rateForModel(model)             # model-keyed
est_cost_wei    = input_tokens × node_price_per_token
margin_percent  = (est_cost_usd − est_cost_wei × eth_usd) / est_cost_usd
```

Tracked per `(model, node)`.

### Images

```
est_cost_usd    = n × usdPerImage(model, size, quality)
est_cost_wei    = n × node_price_per_image                        # node quote is per-image
margin_percent  = (est_cost_usd − est_cost_wei × eth_usd) / est_cost_usd
```

Tracked per `(model, size, quality, node)`.

### Speech

```
est_cost_usd    = chars × rateForSpeechModel(model)               # exact at the boundary
est_cost_wei    = chars × node_price_per_char
margin_percent  = (est_cost_usd − est_cost_wei × eth_usd) / est_cost_usd
```

Tracked per `(model, node)`.

### Transcriptions

```
commit_cost_usd = ceil(reported_seconds) × rateForTranscriptionsModel(model) / 60
commit_cost_wei = ceil(reported_seconds) × node_price_per_second
margin_percent  = (commit_cost_usd − commit_cost_wei × eth_usd) / commit_cost_usd
```

Tracked per `(model, node)`. Reservation drift between the upfront 64-kbps estimate and the committed duration is invisible to margin tracking — both reservation and commit observe the same rate.

`margin_percent` is the single top-line metric for pricing health across all five endpoint families.

## Adjustment policy

| Situation                                               | Response                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Quarterly review                                        | Reassess each tier against competitive references and observed margin.     |
| `margin_percent < 20%` sustained for 3 days on any tier | Emergency reprice OR drop the offending node.                              |
| ETH/USD drops 15%+ in 7 days                            | Reassess — effective USD-denominated escrow shrinks; reprice if sustained. |
| New model family introduced                             | Map to an existing tier; no change to the rate card.                       |

Rate changes are **never retroactive**. Prepaid balances consume at the rate in effect at spend time, not top-up time.

## Why the customer never sees wei

The rate card deliberately quotes USD only. Wei-denominated node cost is an input to `margin_percent` and to reconciliation against the PayerDaemon ledger (three-ledger check: CustomerLedger USD, PayerDaemon EV, TicketBroker on-chain ETH). It is invisible to the customer — a core belief (`core-beliefs.md#3`).

## Related code

- Types: `src/types/pricing.ts`.
- (Planned) Service: `src/service/pricing/` — rate card lookup, margin calc, drift metrics. Lands in a later plan.

## Open items (deferred)

- **Volume-discount tiers.** Not in v1. Revisit once revenue shape justifies it.
- ~~**Per-model rate cards.**~~ Resolved in 0017 — embeddings and images are model-keyed; chat remains tier-based.
- **Auto-reprice on margin drop.** Manual in v1; automation requires a policy doc of its own.
- ~~**Audio endpoints pricing.**~~ Resolved in 0019 — speech is per-character, transcriptions is per-minute, both model-keyed. See "Speech rate card" and "Transcriptions rate card" sections above.
