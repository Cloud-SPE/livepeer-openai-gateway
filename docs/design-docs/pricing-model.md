---
title: Pricing model (rate card + margin policy)
status: accepted
last-reviewed: 2026-04-25
---

# Pricing model

The bridge prices three distinct endpoint families with three distinct rate structures:

- **Chat** (`/v1/chat/completions`) — tier-based. Models are grouped into tiers; rates price tiers, not individual models. Keeps the customer-facing surface stable when new models are added or swapped.
- **Embeddings** (`/v1/embeddings`) — model-keyed. Embedding models are not swappable (vector dimensions differ), so tier abstraction adds no value.
- **Images** (`/v1/images/generations`) — model × size × quality keyed. Per-image pricing is the industry standard; there is no token dimension.

## Competitive positioning

**Design goal: Cloud-SPE is the cheapest mainstream OpenAI-compatible endpoint at every commodity tier (`starter`, `standard`, `pro`), with an additional `premium` tier for niche / fine-tuned / single-user-serving workloads that compete on value rather than price.**

The four `v2` chat tiers + the four model-keyed cards (embeddings, images, speech, transcriptions) are sized as follows:

- **Commodity tiers** (`starter`, `standard`, `pro`) strictly undercut every benchmarked commercial competitor as of the rebalance (`2c40cbb`, 2026-04-25): OpenAI, Anthropic (Claude), Together, Replicate, Groq, Deepgram, AssemblyAI, ElevenLabs. They assume the worker is heavily-batched commodity hardware (vLLM with high concurrency on a hyperscaler-class GPU, or a prosumer GPU with `--max-num-seqs ≥ 8`).
- **Premium tier** is positioned BELOW the most expensive commercial frontier offerings (OpenAI gpt-4o, Anthropic Claude Sonnet) but well above commodity. It exists because a single retail GPU running a single model without aggressive batching cannot break even at commodity rates — see "Worker operator economics" below for the math. Premium workers compete on what hyperscalers cannot offer: uncensored fine-tunes, privacy guarantees, specific languages or domains, custom adapters, low-noise serving.

**Cheapness is the brand promise.** The customer-facing rate cards are non-negotiable: every commodity tier strictly undercuts the cheapest commercial competitor. We do NOT raise customer rates to cover worker hardware costs — that defeats the entire positioning. Instead, the worker-side `price_per_work_unit_wei` is set at a deliberately low fraction of the customer rate during the growth phase, and the bridge keeps most of the spread to fund customer acquisition + infra. As the bridge grows demand and worker utilization climbs, operators measure their actual economics and can negotiate rates upward.

The competitive references that drive each tier's number live in the `pricing.ts` comment block (`src/config/pricing.ts`) and are mirrored below for each rate card. When competitor prices change, the playbook is to re-check those benchmarks and bump our rates only enough to preserve the "strictly cheaper at commodity, BELOW frontier at premium" property.

## Worker operator economics

The pricing model has three independent dials. Operators (worker AND bridge) need data to know which one to adjust over time:

1. **Customer rate card** — non-negotiable in growth phase; cheaper-than-OpenAI is the brand. Adjustments are reactive (when a competitor changes price, we re-check we're still strictly cheaper).
2. **Worker `price_per_work_unit_wei`** — fully tunable per-worker per-model. Default values in `worker.example.yaml` are LOW (5–10 % of customer rate) so the bridge keeps the bulk of revenue during the growth phase. Workers participate at a loss expecting volume to grow.
3. **Worker hardware utilization** — outside the bridge's direct control. Bridge does best-effort load balancing + customer acquisition; worker brings the GPU.

### Throughput shapes the achievable price

Same GPU, very different cost-per-token depending on batching:

| Mode | Tokens/sec sustained (gemma3 27B class on RTX 5090) | Tokens/day at 100% util |
| --- | --- | --- |
| Single user (Ollama, no batching) | ~70 t/s | ~6M |
| 4× concurrent (vLLM `--max-num-seqs 4`) | ~250 t/s | ~22M |
| 16× concurrent (vLLM `--max-num-seqs 16`) | ~500 t/s | ~43M |

(Numbers approximate; exact depends on prompt length, model size, quantization, and the inference engine.)

### Worker hardware break-even (reference math, RTX 5090 at $12/day cost)

Break-even price/M tokens for the worker = `daily_cost / daily_tokens`:

| Mode | Break-even ($12/day) | $5/day profit ($17/day rev) |
| --- | --- | --- |
| Single user | $2.00 | $2.83 |
| 4× batched | $0.55 | $0.79 |
| 16× batched | $0.28 | $0.39 |

### Default (growth-phase) tier mapping

| Tier | Bridge customer (avg) | Default `worker.yaml` `price_per_work_unit_wei` (at $4k/ETH) | Worker take | Bridge keeps |
| --- | --- | --- | --- | --- |
| **starter** ($0.05/$0.10) | ~$0.075/M | `1_250_000` (≈ $0.005/M) | ~7 % | ~93 % |
| **standard** ($0.15/$0.40) | ~$0.25/M | `5_000_000` (≈ $0.02/M) | ~8 % | ~92 % |
| **pro** ($0.40/$1.20) | ~$0.80/M | `15_000_000` (≈ $0.06/M) | ~7 % | ~93 % |
| **premium** ($2.50/$6.00) | ~$3.75/M | `75_000_000` (≈ $0.30/M) | ~8 % | ~92 % |

These defaults are **deliberately worker-unfavorable in the short term**. A consumer GPU running at any of these prices loses money against its hardware cost. Workers participate because:

- The bridge is doing customer acquisition + handling Stripe + handling crypto + holding the on-chain deposit + running redemption gas
- Rates can be renegotiated upward once the bridge has demand
- Specialty / niche workers can override `price_per_work_unit_wei` per-model on their own worker.yaml — there's no central control

Workers chasing economic break-even on a single 5090 (no batching) need ~$2/M tokens, i.e. `price_per_work_unit_wei: "500000000"` (≈ 80 % of the premium customer rate, leaving ~20 % bridge margin). They should set that on their own deployment when their measured economics warrant it — see "Measurement and adjustment" below.

### What the bridge operator does

The bridge's role is to make sure workers have **demand**, not capacity. Every worker stack is a sunk cost (GPU + electricity + bandwidth); the GPU costs the same whether it serves 1 token/day or 40 million. The bridge's job is to:

1. **Route requests to the right tier**, so a customer asking for `gemma4:26b` lands on a worker who can profitably serve it at the matching tier.
2. **Aggregate demand** across many small customers so each worker sees consistent load.
3. **Smooth the bursty-traffic problem** with rate-limiting (Redis-backed) and concurrency caps (per-customer, per-worker).
4. **Surface real economics to both sides** — worker operators can see what they earned, bridge operator can see margin per request, both can decide when/how to adjust.

If workers can't see the data, they have no basis to negotiate or to leave. If the bridge can't see the data, it has no basis to set rates intelligently or to know when its growth phase is over. **Measurement is the load-bearing missing piece** — see below.

## Measurement and adjustment

The bridge already records the raw inputs (`usage_record` table, daemon BoltDB, Stripe topup events, on-chain redemptions). What's missing is **operator-facing rollups + projections** that turn those raw rows into a price-tuning decision.

### What's recorded today

| Source | Data | Location |
| --- | --- | --- |
| `usage_record` (postgres) | per-request: customer_id, model, kind, prompt/completion tokens, cost_usd_cents, node_cost_wei, status, timestamp | bridge db |
| `topup` (postgres) | Stripe Checkout settlements per customer | bridge db |
| `node_health_event` (postgres) | circuit-state transitions per worker | bridge db |
| daemon BoltDB | pending winning tickets, redeemed tx hashes, sender nonces | worker daemon `/var/lib/livepeer/payment-daemon.db` |
| Arbitrum One | actual ETH/LPT received from `redeemWinningTicket` events on the recipient address | on-chain |
| Bridge logs | per-request `session started`, `ticket batch created`, `commit reservation` lines | container stdout |

### What's missing (tracked as tech debt)

- **Bridge admin metrics endpoints.** `GET /admin/metrics/daily`, `/admin/metrics/per-worker`, `/admin/metrics/per-tier` — rolled-up views of customer revenue, worker EV paid out, gross margin, per-tier utilization. Today operators have to write SQL by hand against `usage_record`.
- **Worker daemon `/metrics` endpoint.** Prometheus-style counters: `tickets_accepted_total`, `tickets_won_total`, `redemptions_succeeded_total`, `redemptions_failed_total`, `ev_earned_wei_total`, per-sender labels. Today operators tail container logs.
- **Operator-facing economics CLI.** `livepeer-payment-stats --since=7d` reading the daemon BoltDB + on-chain redemptions, producing a markdown report with realized $/M tokens, break-even projection, suggested `price_per_work_unit_wei` adjustment if data warrants. Today the operator does this math in a spreadsheet.
- **Cost-attribution per request.** Single SQL view (or admin endpoint) that joins a chat request to: customer USD billed, ticket EV sent, worker recipient address, redemption tx hash if any. Audit trail for "where did this $0.004 go?" investigations. Today the operator manually correlates timestamps across sources.
- **Bridge-operator economics dashboard.** Even a static HTML page (auto-regenerated nightly) showing daily customer revenue vs daily worker EV vs (operator-input) infra cost vs net margin per tier. Today the operator has nothing.

The lack of these tools is not blocking the deploy — workers can still earn, customers can still pay, the protocol works. But it actively prevents anyone from making an informed pricing decision, which is exactly the loop the user (operator) needs to close to know when growth-phase rates can be moved.

### Adjustment loop (the intent once tooling lands)

1. Bridge operator periodically (weekly) checks `/admin/metrics/per-worker`: tokens served, EV paid, margin per tier.
2. Worker operator periodically checks their own `/metrics` + on-chain redemption events: realized $/M tokens.
3. If a worker's realized-$/M is below their hardware cost AND utilization is high, they raise `price_per_work_unit_wei`. The bridge sees the new quote and either continues routing (its margin shrinks but it's still profitable) or stops routing to that worker (the worker is now overpriced for the tier).
4. If utilization is low across the fleet, the bridge operator drops customer rates further OR invests in customer acquisition.
5. The bridge operator never auto-adjusts — every change is observable and intentional.

## Chat rate card (v2, effective 2026-04-25)

| Tier         | Input $ / 1M tokens | Output $ / 1M tokens | Worker batching expectation | Commercial reference (per 1M, in/out) |
| ------------ | ------------------- | -------------------- | --------------------------- | ------------------------------------- |
| **Starter**  | $0.05               | $0.10                | ≥ 16× concurrent (vLLM heavy) | strictly < OpenAI gpt-4o-mini $0.15 / $0.60 |
| **Standard** | $0.15               | $0.40                | ~10× concurrent             | strictly < Anthropic Claude Haiku $0.25 / $1.25 |
| **Pro**      | $0.40               | $1.20                | ~3-4× concurrent            | strictly < Together llama-3.1-70b $0.88 / $0.88; Replicate llama-3.1-70b ~$0.65 / $2.75 |
| **Premium**  | $2.50               | $6.00                | single-user (no batching), niche / fine-tuned models | strictly < OpenAI gpt-4o $2.50 / $10; Anthropic Claude Sonnet 3.5 $3 / $15 |

Other reference points (2026-04):
- OpenAI gpt-3.5-turbo $0.50 / $1.50 — Cloud-SPE's standard tier beats this on both sides.
- Groq llama-70b $0.59 / $0.79 — Cloud-SPE's pro tier beats input; output edged by Groq but Groq is rate-limited.
- OpenAI gpt-4-turbo $10 / $30 — Cloud-SPE's premium tier 4× cheaper across the board.

Premium is NOT trying to be the cheapest in its class — it exists because a single retail GPU running specialty models without aggressive batching cannot break even at commodity rates (see "Worker operator economics" above). Premium workers earn higher margins; customers pay more for value (uncensored / fine-tuned / privacy / domain expertise) that hyperscalers do not ship.

Free tier consumes against the **Starter** rate for internal cost accounting (quota-capped at 100K tokens / month).

## Embeddings rate card (v2, effective 2026-04-25)

Embeddings are priced per model, input-tokens only. Free tier is not available for embeddings in v1.

| Model                      | $ / 1M tokens | Cheapest commercial reference |
| -------------------------- | ------------- | ----------------------------- |
| `text-embedding-3-small`   | $0.005        | OpenAI $0.020 — Cloud-SPE 4× cheaper |
| `text-embedding-3-large`   | $0.05         | OpenAI $0.130 — Cloud-SPE 2.6× cheaper |
| `text-embedding-bge-m3`    | $0.005        | open-source class; cheapest available  |

## Images rate card (v2, effective 2026-04-25)

Images are priced per `(model, size, quality)`. The customer pays `n × usdPerImage` for a request that returns `n` images.

| Model      | Size       | Quality  | $ / image | Cheapest commercial reference        |
| ---------- | ---------- | -------- | --------- | ------------------------------------ |
| `dall-e-3` | 1024×1024  | standard | $0.025    | OpenAI $0.040 — Cloud-SPE 1.6× cheaper |
| `dall-e-3` | 1024×1024  | hd       | $0.050    | OpenAI $0.080 — Cloud-SPE 1.6× cheaper |
| `dall-e-3` | 1024×1792  | standard | $0.040    | OpenAI $0.080 — Cloud-SPE 2× cheaper  |
| `dall-e-3` | 1024×1792  | hd       | $0.075    | OpenAI $0.120 — Cloud-SPE 1.6× cheaper |
| `dall-e-3` | 1792×1024  | standard | $0.040    | OpenAI $0.080 — Cloud-SPE 2× cheaper  |
| `dall-e-3` | 1792×1024  | hd       | $0.075    | OpenAI $0.120 — Cloud-SPE 1.6× cheaper |
| `sdxl`     | 1024×1024  | standard | $0.002    | Replicate / Together SDXL ~$0.003     |

**Partial delivery.** If the node returns fewer images than `n`, the customer is billed for `data.length × usdPerImage` and the delta is refunded. A zero-image response is a node contract violation (503 + full refund). See `docs/references/worker-node-contract.md §5.3`.

## Speech rate card (v2, effective 2026-04-25)

Speech (TTS) is priced per character of `input`. Char count is exact at the bridge boundary, so the upfront reservation equals the final commit — no reconciliation drift.

| Model      | $ / 1M chars | Cheapest commercial reference        |
| ---------- | ------------ | ------------------------------------ |
| `tts-1`    | $5           | OpenAI $15 — Cloud-SPE 3× cheaper     |
| `tts-1-hd` | $12          | OpenAI $30 — Cloud-SPE 2.5× cheaper   |
| `kokoro`   | $1           | open-source class; ElevenLabs $30+ for comparable quality |

Free tier is not available for `/v1/audio/speech` in v1 (matches embeddings + images precedent).

## Transcriptions rate card (v2, effective 2026-04-25)

Transcriptions (STT) is priced per minute of audio. The upfront reservation is sized at a worst-case bitrate (64 kbps) capped at 60 minutes; the actual commit uses the duration the node reports via the `x-livepeer-audio-duration-seconds` response header.

| Model       | $ / min   | Cheapest commercial reference                 |
| ----------- | --------- | --------------------------------------------- |
| `whisper-1` | $0.003    | OpenAI $0.006; Deepgram $0.0043; AssemblyAI $0.0065 — Cloud-SPE strictly cheaper than all three |

If the worker omits the duration header on a 2xx response, the bridge returns `503 service_unavailable` and refunds the reservation in full (matches the universal "no usage = no bill" rule from 0007 — see `docs/references/worker-node-contract.md §7.3`).

Free tier is not available for `/v1/audio/transcriptions` in v1.

## Rounding semantics

All five rate cards collapse to a single primitive: **micro-cents** (¹⁄₁₀_₀₀₀ of a cent), summed across all per-side contributions, then divided + ceil'd to integer cents exactly **once** at the end. This invariant matters because the v2 rate cards are aggressively cheap — a 5-prompt + 3-output token chat request at the starter tier amounts to fractions of a cent, and the wrong rounding order silently truncates the entire charge to zero.

The implementation lives in `src/service/pricing/index.ts::computeCostCents`:

```
inputCentsPerMillion  = round(usd_per_M_input  * 100 * 10_000)   // micro-cents per 1M tokens
outputCentsPerMillion = round(usd_per_M_output * 100 * 10_000)
microPerMillion = promptTokens * inputCentsPerMillion
                + outputTokens * outputCentsPerMillion
denom  = MILLION × 10_000                                          // tokens × micro-cents
cents  = ceil(microPerMillion / denom)
```

**The bug this guards against (fixed in `2c40cbb`).** The earlier impl divided each side by `MILLION` *before* summing — for sub-cent amounts the per-side integer division floored to 0, the sum was 0, and the ceil over 0 stayed at 0 (a 5+3 token request returned 0 cents instead of 1). Sum the micros first; divide+ceil exactly once at the end. The same shape applies to embeddings (`computeInputOnlyCostCents`), images (`computePerImageCents`), speech (`computePerCharCents`), and transcriptions (`computePerSecondCents`) — each scaled by 10_000 micro-cents for the same precision-then-ceil pattern.

The customer-facing semantics: **every billable event rounds up to the nearest cent**. A 1-token chat request at the cheapest tier costs 1 cent. There is no fractional billing in v1 — the prepaid balance is integer cents and the ledger has no sub-cent units.

## Ticket-EV granularity floor

The probabilistic ticket protocol has a hard floor independent of the rate cards: **1 ticket's expected value (EV)** is the smallest unit of payment that can flow on-chain. The receiver daemon targets a per-ticket EV of `--receiver-ev-wei` (default `1e12` wei ≈ $0.004 EV/ticket at $4k/ETH) and sizes `face_value × winProb` accordingly. Each request the bridge sends through the `PayerDaemon` includes 1+ tickets — for very small requests the per-ticket EV strictly exceeds what the customer paid.

**Worked example.** A 5-token chat request at the starter rate costs 1 cent (≈ $0.01). A single ticket is worth ~$0.004 EV. The bridge must include at least one ticket per request, so the protocol-level cost is `~$0.004` against a customer payment of `$0.01` — the bridge "overpays" relative to a hypothetical fractional-ticket world by the difference. For a 1k-token request the customer pays ~$0.0001 (Starter input rate); the protocol cost is still ~$0.004 / ticket, the math inverts and the daemon would either need to include sub-1 tickets (impossible) or the bridge subsidizes the ticket cost against future requests in the same session.

**The v2 rate cards assume amortization** across many requests per session. A long-running chat conversation (e.g., a coding agent making thousands of completions through one API key) amortizes the per-ticket EV cost down to negligible. Sub-1k-token one-shot requests don't amortize and the bridge effectively pays slightly more per request than the customer paid.

**Solution space (no code fix in v1):**

1. **Lower `--receiver-ev-wei` further.** But `face_value` then drops below the redemption-profitability floor (`face_value > gasPrice × RedeemGas`), so individually unprofitable tickets accumulate and clog the queue.
2. **Accept the slight overpayment for tiny requests** as the cost of the protocol's granularity. This is the v1 stance.
3. **Batch payments across multiple requests per session.** The daemon's session model permits this (one session, many `CreatePayment` calls), but the bridge currently bills per-request via the worker's middleware. A bridge-side change to defer ticket creation across N requests would amortize at the cost of more bookkeeping and stronger session-affinity guarantees.

Tracked as `per-ticket-ev-vs-request-size` in the library tech-debt tracker. Cross-reference: `--receiver-ev-wei` flag in [livepeer-payment-library/docs/operations/running-the-daemon.md](https://github.com/Cloud-SPE/livepeer-modules/blob/main/payment-daemon/docs/operations/running-the-daemon.md).

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
- ~~**v1 rate cards (premium-over-OpenAI positioning).**~~ Resolved in `2c40cbb` (2026-04-25) — replaced with v2 rate cards positioning Cloud-SPE as the cheapest mainstream OpenAI-compatible endpoint. Margin shifts to the worker-side ~10× spread.
