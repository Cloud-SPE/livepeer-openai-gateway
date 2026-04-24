---
title: Pricing model (rate card + margin policy)
status: accepted
last-reviewed: 2026-04-24
---

# Pricing model

The bridge runs a three-tier rate card. Models are grouped into tiers; rate cards price tiers, not individual models. This keeps the customer-facing surface stable when new models are added or nodes are swapped.

## Rate card (v1 starter, monitor and adjust)

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

## Types

- `src/types/pricing.ts` — `PricingTier` (`starter | standard | pro`), `RateCardEntry`, `RateCard`, `ModelTierMap`.
- A `RateCard` carries exactly three entries (enforced by Zod) and a `version` + `effectiveAt` so we can version rate cards in-repo and reprice without mutating history.

## Margin math

Per request:

```
est_cost_usd    = max_tokens × customer_rate_per_token           # from rate card
est_cost_wei    = max_tokens × node_price_per_token              # from NodeBook quote
margin_percent  = (est_cost_usd − est_cost_wei × eth_usd) / est_cost_usd
```

`margin_percent` is tracked per `(tier, model, node)` and is the single top-line metric for pricing health.

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
- **Per-model rate cards.** Explicitly deferred; the three-tier policy is the v1 simplification.
- **Auto-reprice on margin drop.** Manual in v1; automation requires a policy doc of its own.
