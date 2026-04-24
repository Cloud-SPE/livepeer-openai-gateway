# OpenAI-Compatible API Bridge — Architecture

> **Purpose of this document.** Architecture reference for an OpenAI-compatible API service that sits in front of Livepeer inference nodes and handles customer billing in USD while paying nodes via the probabilistic-micropayment protocol.
>
> **Relation to the main architecture doc.** This doc builds on `livepeer-payments-abstraction.md` (the generic payment-daemon architecture). Primitives like `PayerDaemon`, `PayeeDaemon`, `WorkID`, `workUnits`, `Capability`, and `GetQuote` are defined there. This doc specializes them into a concrete application.
>
> **Audience.** Engineers building or operating the bridge. Assumes familiarity with the abstraction doc.

---

## Table of contents

1. [Use case](#1-use-case)
2. [Actors and naming](#2-actors-and-naming)
3. [Internal components of APIService](#3-internal-components-of-apiservice)
4. [Customer tiers](#4-customer-tiers)
5. [Request flows](#5-request-flows)
   - 5.1–5.6 flow diagrams
   - 5.7 Retry policy
   - 5.8 Rate limiting
6. [Dual pricing plane (USD ↔ ETH)](#6-dual-pricing-plane-usd--eth)
   - 6.2 Customer rate card (Starter / Standard / Pro)
   - 6.2.1 Rate adjustment policy
7. [Token audit strategy](#7-token-audit-strategy)
8. [Escrow and operational concerns](#8-escrow-and-operational-concerns)
   - 8.2 ETH reserve (v1 soft-launch sizing: $1K)
9. [Risks and mitigations](#9-risks-and-mitigations)
10. [v1 scope](#10-v1-scope)
11. [Backlog / v2+](#11-backlog--v2)
12. [Open decisions](#12-open-decisions)
13. [Appendix A — CustomerLedger data model sketch](#appendix-a--customerledger-data-model-sketch)
14. [Appendix B — NodeBook data model sketch](#appendix-b--nodebook-data-model-sketch)

---

## 1. Use case

The operator runs an **OpenAI-compatible API service**. Customers sign up, receive API keys, and use the standard OpenAI SDK with a custom `base_url`. The service accepts those calls, routes them to a pool of Livepeer **WorkerNodes** that perform the inference, pays those nodes via the payment daemon architecture, and bills customers in USD.

```
┌──────────────┐    HTTPS + API key     ┌────────────┐    payment-daemon    ┌─────────────┐
│   Customer   │ ─────────────────────► │ APIService │ ◄──── protocol ────► │ WorkerNodes │
│ (OpenAI SDK) │ ◄───── response ─────  │  (bridge)  │                      │  (pool)     │
└──────────────┘                        └────────────┘                      └─────────────┘
         ↑ USD billing, prepaid               ↓                                    ↓
         │                                    └─► Stripe / fiat ─┐        ETH + TicketBroker
         └────────── invoices, top-ups ◄──────────────────────────┘          (settlement)
```

The customer never sees crypto. The operator bridges two economies: USD inbound from customers, ETH outbound to nodes.

---

## 2. Actors and naming

Three distinct actors. Internal component names below are meant to be used consistently in code and documentation.

| Name | Role | In payment-daemon vocabulary |
|---|---|---|
| **Customer** | The developer making OpenAI SDK calls using an API key issued by APIService. Pays in USD. Never sees tickets, ETH, or nodes. | Not part of the payment-daemon protocol. |
| **APIService** | The OpenAI-compatible HTTP service. Owns customer accounts, routes requests to nodes, bridges USD↔ETH. | Specialized **PayerApp**. |
| **WorkerNode** | A remote node serving OpenAI-compatible endpoints for one or more models. Gets paid per token. | Specialized **PayeeApp**. |
| **PayerDaemon** | Local payment daemon next to APIService. | (unchanged from abstraction doc) |
| **PayeeDaemon** | Local payment daemon next to each WorkerNode. | (unchanged from abstraction doc) |
| **TicketBroker** | Ethereum contract. | (unchanged) |

**Key point**: `APIService` is not a new kind of component — it is a `PayerApp` with SaaS plumbing on top. Same for `WorkerNode` as a `PayeeApp`. The daemon architecture doesn't change.

The product name visible to customers is the operator's choice; "APIService" is used throughout this document as a placeholder.

---

## 3. Internal components of APIService

These are logical components. Whether they're one process, several microservices, or a monolith is an implementation choice.

| Component | Responsibility |
|---|---|
| **AuthLayer** | Validates API keys, maps to customer account, applies tier-based rate limits, enforces quota (for free-tier customers). |
| **CustomerLedger** | Authoritative source of customer balance (USD for prepaid) or quota state (tokens for free). Per-call debits are atomic. Refunds on failure. |
| **NodeBook** | In-memory registry of known WorkerNodes: URL, ETH address, supported models, current quote (`TicketParams` + `PriceInfo`), health status, enabled flag. Config-driven in v1. |
| **Router** | Per-request: picks a WorkerNode from NodeBook based on requested model, tier, node health, price, and capacity. Handles failover/retry on node errors. |
| **PayerClient** | Thin local gRPC client stub that calls PayerDaemon. Lives inside APIService; not a separate process. |
| **QuoteRefresher** | Background job polling each WorkerNode's `GetQuote` every N seconds. Caches results in NodeBook. |
| **EscrowMonitor** | Reads APIService's deposit/reserve state on TicketBroker. Alerts when deposit runs low. Optionally triggers auto-top-up from fiat reserves in v1.5+. |
| **LocalTokenizer** | (v1 in metric mode, v2 in enforcement mode.) Tokenizes requests and responses locally and cross-checks against WorkerNode's reported token counts. Emits drift metrics. |
| **SignupService** | Creates new customer accounts. Email verification. API key issuance. Tier assignment. |
| **BillingService** | Stripe integration for prepaid top-ups. Webhook handling. Ledger credits on successful payment. |

---

## 4. Customer tiers

Two tiers at launch: **Free** and **Prepaid**. A future **Enterprise/Postpaid** tier is explicitly deferred.

### 4.1 Free tier

Purpose: let developers try the service without a credit card. Marketing + onboarding cost.

| Limit | Default (configurable) |
|---|---|
| Token allowance | 100,000 tokens per calendar month |
| Rate limit | 3 requests/minute, 200 requests/day |
| Concurrent requests | 1 |
| Available models | 1–2 cheapest models only (restricted via NodeBook) |
| Max tokens per request | 1024 |
| Streaming | Allowed |
| Seamless upgrade | Adding USD flips account to prepaid tier mid-cycle; quota becomes irrelevant |

Abuse prevention (v1):
- Email verification required at signup.
- IP-based rate limit on signup endpoint (prevent multi-accounting).
- One free tier per email address.

Abuse prevention (v1.5+):
- Phone/SMS verification.
- Device fingerprinting.
- Behavioral heuristics (repeated zero-balance hits, suspicious prompt patterns).

Economic framing for the operator:
- Free tier is a direct cost. Budget = `expected_free_users × 100K_tokens × node_cost_per_token`.
- Route free traffic to the cheapest WorkerNodes only.
- Consider a "free tier reserved pool" — 1–2 nodes dedicated to free traffic so paid customers never contend with free load.

### 4.2 Prepaid tier

Purpose: the main revenue model. Customers buy USD credit; credit is consumed per call; hard-stop at zero.

| Feature | Behavior |
|---|---|
| Top-up | Stripe (or similar) checkout → CustomerLedger credit. One-time only in v1; auto-reload in v1.5. |
| Balance check | Request-path middleware. Rejects if `balance < estimatedMaxCost` before routing. |
| Debit | Atomic, under row lock. Prevents concurrent-request double-spend. |
| Rate limit | Higher than free tier; configurable per customer. |
| Available models | Full rate card. |
| Max tokens per request | Full (`max_tokens` capped only by model's context window). |
| Low-balance notification | Email/webhook at ~20% remaining. |
| Refund on failure | If node errors or stream aborts early, credit back unused portion. |
| Account closure / refund | Manual ops process in v1. |

### 4.3 Enterprise / Postpaid (deferred, v2+)

Not in v1. When added, will require:
- Real credit policy and risk limits.
- Invoice generation, dunning, collections.
- SLA commitments.
- Dedicated node pools or priority routing.

---

## 5. Request flows

### 5.1 Signup (free tier)

```
Customer                  APIService (SignupService)               CustomerLedger
   │  POST /signup              │                                        │
   │  {email, password}         │                                        │
   ├───────────────────────────►│                                        │
   │                            │  send verification email               │
   │                            │                                        │
   │  GET /verify?token=...     │                                        │
   ├───────────────────────────►│                                        │
   │                            │  create customer record                │
   │                            │  tier = "free"                         │
   │                            │  quota_remaining = 100_000 tokens      │
   │                            │  quota_reset_date = first of next month│
   │                            ├───────────────────────────────────────►│
   │                            │  issue API key                         │
   │  {api_key: "sk-..."}       │                                        │
   │◄───────────────────────────┤                                        │
```

### 5.2 Top-up (prepaid tier)

```
Customer              APIService (BillingService)      Stripe            CustomerLedger
   │  POST /billing/topup │                               │                    │
   │  {amount_usd: 25}    │                               │                    │
   ├─────────────────────►│  create Stripe Checkout       │                    │
   │                      ├──────────────────────────────►│                    │
   │  redirect to Stripe  │                               │                    │
   │◄─────────────────────┤                               │                    │
   │  (customer pays on Stripe)                           │                    │
   │                      │  webhook: payment_succeeded   │                    │
   │                      │◄──────────────────────────────┤                    │
   │                      │  credit customer balance += $25                    │
   │                      ├───────────────────────────────────────────────────►│
   │                      │  tier = "prepaid" (if was free)                    │
```

### 5.3 `/chat/completions` non-streaming

```
Customer       APIService                                  WorkerNode
  │  POST /v1/chat/completions                                  │
  │  Authorization: Bearer sk-...                               │
  │  {model, messages, max_tokens}                              │
  ├────────────────►│                                           │
  │                 │ AuthLayer: validate key, load customer    │
  │                 │                                           │
  │                 │ CustomerLedger: check balance/quota ≥     │
  │                 │   est_cost(max_tokens × customer_rate)    │
  │                 │                                           │
  │                 │ Router: pick WorkerNode from NodeBook     │
  │                 │   filter by: model, tier-allowed, healthy │
  │                 │                                           │
  │                 │ generate workID = {customer_id}:{uuid}    │
  │                 │                                           │
  │                 │ PayerClient → PayerDaemon:                │
  │                 │   CreatePayment(workID, max_tokens,       │
  │                 │                 node.ticketParams)        │
  │                 │                                           │
  │                 │  POST /v1/chat/completions + payment hdr  │
  │                 ├──────────────────────────────────────────►│
  │                 │                                           │ ProcessPayment
  │                 │                                           │ (runs inference)
  │                 │  response.body.usage = {                  │
  │                 │    prompt_tokens: 120,                    │
  │                 │    completion_tokens: 450                 │
  │                 │  }                                        │
  │                 │◄──────────────────────────────────────────┤ DebitBalance
  │                 │                                           │ (sender, workID,
  │                 │ LocalTokenizer (v1, metric):              │  570 tokens)
  │                 │   count tokens in response,               │
  │                 │   emit drift metric                       │
  │                 │                                           │
  │                 │ CustomerLedger: debit                     │
  │                 │   570 × customer_rate_per_token           │
  │                 │                                           │
  │  response       │                                           │
  │◄────────────────┤                                           │
```

### 5.4 `/chat/completions` streaming

```
Customer       APIService                                  WorkerNode
  │  POST /v1/chat/completions (stream=true)                    │
  ├────────────────►│                                           │
  │                 │ (Auth + balance check + pick node         │
  │                 │  + CreatePayment — same as non-streaming) │
  │                 │                                           │
  │                 │ inject stream_options.include_usage=true  │
  │                 │   (if customer didn't set it)             │
  │                 │                                           │
  │                 ├──────────────────────────────────────────►│
  │                 │                                           │ ProcessPayment
  │                 │                                           │ starts streaming
  │                 │  SSE: data: {token chunk}                 │
  │                 │◄──────────────────────────────────────────┤
  │  SSE forwarded  │                                           │
  │◄────────────────┤ (LocalTokenizer counts tokens as they     │
  │                 │  pass through — v1 metric)                │
  │                 │                                           │
  │                 │  ... many chunks ...                      │
  │                 │                                           │
  │                 │  SSE: data: {..., "usage": {              │
  │                 │    "prompt_tokens": 120,                  │
  │                 │    "completion_tokens": 450}}             │
  │                 │◄──────────────────────────────────────────┤
  │                 │                                           │
  │                 │ if customer didn't ask for usage,         │
  │                 │   strip usage chunk from forwarded stream │
  │                 │                                           │
  │                 │  SSE: data: [DONE]                        │
  │                 │◄──────────────────────────────────────────┤ DebitBalance
  │  [DONE]         │                                           │ (actual tokens)
  │◄────────────────┤                                           │
  │                 │ CustomerLedger: debit 570 × rate          │
```

**Streaming pre-payment policy (v1, locked):**
- At request start, reserve `max_tokens × customer_rate` from CustomerLedger (atomic). Visible to customer as `balance − reserved`.
- At stream end, debit `actual_tokens × customer_rate` and refund `reserved − actual` in the same transaction.
- On failure: refund the full reservation and debit only tokens actually delivered.
- Unused pre-payment on the PayeeDaemon side stays credited to the session and amortizes over future calls — not wasted.

**Streaming gotchas** (must be tested explicitly):
- `stream_options.include_usage` injection/stripping to avoid changing the customer's response shape.
- Customer disconnect mid-stream → cancel upstream, debit only delivered tokens, refund rest.
- Network failure APIService↔WorkerNode mid-stream → debit for tokens actually delivered to customer, surface partial-success error.

### 5.5 Node onboarding (manual v1)

```
Operator                   APIService (config + NodeBook)
   │  edit nodes.yaml           │
   │  add {url, eth_address,    │
   │       supported_models,    │
   │       enabled: true}       │
   │                            │
   │  send SIGHUP               │
   ├───────────────────────────►│
   │                            │  reload NodeBook config
   │                            │  QuoteRefresher picks up new node
   │                            │  polls GetQuote, caches quote
   │                            │  health checks begin
```

### 5.6 Failure / refund

Applies to both non-streaming and streaming:

- **WorkerNode returns 5xx before any tokens delivered** → Router retries on a different node (up to N times). CustomerLedger not debited for the failed attempt. `PayerDaemon` debit is never triggered on the failed node because the job didn't complete.
- **WorkerNode times out mid-stream** → debit CustomerLedger for tokens actually delivered to customer; surface `{error: "stream_terminated_early", tokens_delivered: N}` so the customer can see partial billing.
- **All retries exhausted** → return `503 Service Unavailable`, no debit.
- **Customer cancels request** → cancel upstream, debit delivered tokens only.
- **Validation/auth failure** → 4xx, no debit, no node routing.

### 5.7 Retry policy (v1, locked)

| Error class | Retry? | Max retries | Notes |
|---|---|---|---|
| Network error / timeout contacting node | Yes | 2 on different nodes | Short backoff (100ms, 500ms) |
| 5xx from node (502/503/504) | Yes | 2 on different nodes | Same |
| 5xx inference failure (OOM, model crash) | Yes | 1 on different node | |
| 4xx from node (validation, auth) | No | — | Surface to customer as-is |
| Payment insufficient (node rejects payment) | Yes | 1 | Force-refresh that node's quote, retry once |
| **Streaming, after any token delivered** | **No** | — | Debit delivered tokens, surface partial-success error |
| `ErrTicketParamsExpired` from PayeeDaemon | Yes | 1 | Force-refresh that node's quote, retry once |

Retries hop to a **different** WorkerNode by default. Hammering the same node rarely helps and makes failure cascades worse.

### 5.8 Rate limiting (v1, locked)

- **Redis-backed sliding window**, keyed by `customer_id` (not API key — a customer may have many keys, limits are the customer's total).
- **Two layers**: global (requests/min) + per-tier (free vs. prepaid).
- **Concurrent-request limit** per customer: 1 for free, configurable for prepaid.
- **On limit hit**: `429 Too Many Requests` with OpenAI-compatible headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`.
- **Redis outage**: fail open (allow the request) — rate-limit outage must not take down the whole API. Rate-limit state is ephemeral; Redis without persistence is fine.

---

## 6. Dual pricing plane (USD ↔ ETH)

This is the core complexity unique to the bridge. The generic payment-daemon architecture doesn't have it.

### 6.1 Two currencies, two rate cards

- **Node cost**: wei per token. Set by each WorkerNode's `PriceInfo`. Quoted via `GetQuote`. Volatile (nodes compete, ETH price moves).
- **Customer cost**: USD per 1M tokens. Set by operator in a rate card. Stable by design; customers expect predictable pricing.

The operator's margin is the delta between these, measured in USD-equivalent terms after converting node costs at the current ETH/USD rate.

### 6.2 Customer rate card (v1 starter, monitor and adjust)

Models are grouped into **3 price tiers**, not priced per-model. Each model in NodeBook is mapped to one tier. Cleaner ops; rate card doesn't change when models are added.

| Tier | Input $/1M | Output $/1M | Target model class | Competitive reference (late-2025/early-2026) |
|---|---|---|---|---|
| **Starter** | $0.20 | $0.60 | small (7B–13B class) | GPT-4o-mini: $0.15/$0.60; Groq Llama 70B: $0.59/$0.79 |
| **Standard** | $1.00 | $3.00 | medium (~70B) | Claude Haiku: $0.80/$4.00 |
| **Pro** | $3.00 | $10.00 | large (frontier) | Claude Sonnet: $3.00/$15.00; GPT-4o: $2.50/$10.00 |

Free tier consumes against the Starter tier's pricing (quota-capped).

Customer-facing pricing must cover:
- Worst-case node cost across all allowlisted nodes serving this tier.
- ETH/USD volatility buffer (assume ETH can move 30–40% against you in a month).
- Operator margin.
- Free-tier subsidy amortization (paid users indirectly fund free traffic).

### 6.2.1 Rate adjustment policy

- **Normal cadence**: quarterly review.
- **Emergency**: if `margin_percent` drops below 20% on any tier for 3 consecutive days, reprice or drop the underlying node.
- **Never retroactive** — existing prepaid balances consume at the rate in effect when spent, not when topped up.
- **Monitoring metrics** (dashboard from day one):
  - `revenue_per_token_usd{tier, model}` — what customers paid
  - `node_cost_per_token_usd{node, model}` — node wei × current ETH/USD
  - `margin_percent{tier, model}` = (revenue − cost) / revenue — **the key metric**
  - `eth_usd_rate` — with 7d/30d volatility band
  - `free_tier_subsidy_usd_daily` — cost of carrying free users

### 6.3 Per-call math

```
est_cost_usd          = max_tokens × customer_rate_per_token
est_cost_wei          = max_tokens × node_price_per_token
payment               = ticket_batch covering est_cost_wei (plus safety buffer)

(after response)
actual_cost_usd       = actual_tokens × customer_rate
actual_cost_wei       = actual_tokens × node_price

CustomerLedger.debit(customer_id, actual_cost_usd)
PayeeDaemon.DebitBalance(sender, workID, actual_tokens)
```

### 6.4 Reconciliation

Three sets of books must approximately reconcile:

1. **CustomerLedger** — sum of USD debited across all customers.
2. **PayerDaemon off-chain** — sum of EV committed across all nodes (in ETH).
3. **TicketBroker on-chain** — sum of ETH actually moved via redeemed winning tickets.

Expected relationships:
- `sum(CustomerLedger debits)` should equal `(sum(node payments in ETH) × ETH_USD_rate) × (1 + margin)`, within ETH price drift.
- `sum(TicketBroker redemptions)` should approximately equal `sum(PayerDaemon EV committed)`, within the expected statistical variance of probabilistic payments.

Build a reconciliation dashboard showing all three. Investigate drift above configurable thresholds.

---

## 7. Token audit strategy

**v1: local tokenizer as metric only. No enforcement.**

### 7.1 Why metric-only in v1

- Tokenizer edge cases (special tokens, streaming boundary splits, `cl100k_base` vs `o200k_base` vs Llama tokenizers) will cause false-positive rejections on legitimate traffic.
- You need baseline drift data per node and model before you can set sensible enforcement thresholds.
- Billing pipeline shouldn't be blocked on tokenizer bugs in the first weeks of operation.

### 7.2 Implementation

- Prompt tokens: tokenize locally before sending (free — you already have the prompt).
- Completion tokens: tokenize as chunks stream through (streaming) or on final response body (non-streaming).
- Store both `local_token_count` and `node_reported_token_count` in CustomerLedger for every request.
- Emit metric `tokens.drift.percent{node, model}` = `(node_reported - local) / local`.

### 7.3 Progression

| Phase | Action |
|---|---|
| **v1 (observe)** | Metrics only. Per-node drift dashboard. |
| **v1.5 (audit)** | Alert operator on sustained drift > 5%. |
| **v2 (enforce)** | Reject node's count, use local count as source of truth for billing. Blacklist nodes with persistent large drift. |

Enforcement in v2 requires choosing whether to debit the WorkerNode's `PayeeDaemon` based on local or reported count. If enforcement is strict, APIService can simply call `DebitBalance` with the local count (nodes see less revenue than they reported). This needs a renegotiation of trust with the node operators — get their buy-in before turning it on.

---

## 8. Escrow and operational concerns

### 8.1 Escrow sizing

APIService's TicketBroker deposit is shared across all WorkerNodes it pays. `pendingAmount` from each active session reduces effective float.

Rule of thumb:
```
min_deposit = sum_over_nodes (max_concurrent_tickets × faceValue) × safety_factor(2x)
```

Underfunded escrow → `PayerDaemon` refuses `CreatePayment` → customer calls start failing. Monitor deposit level continuously via EscrowMonitor; alert well before depletion.

### 8.2 ETH reserve (v1 soft-launch sizing)

**v1 sizing: $1,000 USD-equivalent in ETH (~0.294 ETH at $3,400/ETH).** This is private-beta / soft-launch scale. Scale to $10K+ before general availability; revisit after 30 days of traffic data.

```
Total operator ETH reserve:       $1,000 USD (~0.294 ETH)
Active TicketBroker deposit:      $900   USD (~0.265 ETH)   [90% — initial deposit]
Operator hot wallet:              $100   USD (~0.029 ETH)   [for gas / small ops tx]
Low-water alert threshold:        $400   USD                [when deposit drops here]
Top-up trigger:                   Immediate — from fiat revenue when alert fires
```

**Design rationale:**
- 90% in TicketBroker keeps the math simple: one wallet to watch.
- $100 hot wallet is enough to pay gas for occasional on-chain actions (deposit top-ups, unlocks, emergencies).
- No cold-storage split at this tier — at $1K, splitting custody adds human-error risk for no meaningful security gain. Reconsider cold split when reserve passes ~$20K.

**First 30 days — what to watch:**
- `daily_wei_burn_actual` — if this exceeds ~$50/day, you're at 20-day runway; alarm.
- `redemption_rate` = (winning tickets redeemed) / (winning tickets identified). Should be near 1.0; if not, on-chain issue.
- `eth_price_drawdown_7d` — if ETH drops 15%+, effective USD-denominated reserve shrinks; reconsider customer pricing.

**Scaling triggers:**
- Burn exceeds 10% of reserve per week sustained → raise reserve to $10K.
- Peak-hour concurrent requests cause `CreatePayment` rejections → raise deposit percentage.
- General availability launch → minimum $10K reserve, reconsider cold/hot split.

### 8.3 Key custody

APIService's ETH signing key lives in `PayerDaemon`'s encrypted keystore. This is the default custody model from the abstraction doc (§13.2). Operational consequences:

- Keystore passphrase must be provided to `PayerDaemon` at startup. Options: env var (dev/staging), secret manager (prod), KMS (hardened prod).
- Lose the key = lose the escrow. Back it up with the same rigor as any production secret.
- Rotating the key means draining the old escrow, funding a new one, re-signing quotes. Plan this operationally before launch if rotation might be needed.

### 8.4 Node-side key custody

Each WorkerNode's operator owns their own `PayeeDaemon` key. Not APIService's concern — but you should require that nodes have persistent key custody (otherwise their winning-ticket queue can vanish on restart, and they'll blame you).

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Node over-reports tokens** | LocalTokenizer metrics in v1; enforcement in v2. Per-node drift dashboard. Blacklist policy. |
| **Node goes offline mid-request** | Router retry on different node. Customer sees partial-success if some tokens delivered. |
| **All nodes for a model unavailable** | 503 to customer. No debit. Alert on pattern. |
| **ETH/USD price crash** | Customer pricing has volatility buffer. Reprice customer rate card if sustained drop. |
| **Escrow depletion** | EscrowMonitor alerts. Operator-funded top-up. v1.5 auto-top-up. |
| **Free tier abuse (multi-accounting)** | Email verification in v1, phone in v1.5, rate limits on signup, behavioral heuristics in v2. |
| **Prepaid customer balance exploit** (race condition) | Atomic debit with row lock. Reserve `est_max_cost` at request start, reconcile with `actual_cost` at end. |
| **Regulatory / compliance** | Operator holds customer USD (money transmitter concerns in some jurisdictions) AND ETH (VASP concerns). Consult counsel before launch. |
| **PayerDaemon unreachable (sidecar outage)** | Fail-closed: customer calls return 503. EscrowMonitor and PayerClient both health-check. |
| **Customer sends `max_tokens=999999`** | Cap `max_tokens` per tier in AuthLayer before it reaches Router. Free tier: 1024. Prepaid: capped by model's context window. |

---

## 10. v1 scope

Locked decisions (this document + the abstraction doc):

| Area | v1 choice |
|---|---|
| Endpoints | `/chat/completions` only (streaming + non-streaming) |
| Customer tiers | Free + Prepaid |
| Free-tier quota | 100,000 tokens/month (placeholder; monitor and adjust) |
| Free-tier models | Exactly one model (cheapest in the Starter tier) |
| Billing model | Prepaid USD balance via Stripe, quota-based free tier |
| Stripe setup | USD only; no automated refunds (manual ops, 30-day window); Stripe Tax enabled; single "API Credits" product with custom amount (detailed config later) |
| Signup | Email verification only |
| Node discovery | Config-driven allowlist; manual onboarding via config file + SIGHUP reload; 3–5 nodes at launch (mix: 1–2 for free tier, 2–3 for prepaid) |
| Models & pricing | 3 customer-facing tiers (Starter / Standard / Pro) — see §6.2. Monitor and adjust. |
| Token audit | LocalTokenizer as metric-only (§7) |
| Streaming pre-payment | Pre-charge `max_tokens` worst case, refund unused at stream end (§5.4) |
| Retry policy | Up to 2 retries on different nodes for 5xx / network errors; no retry after any token delivered in a stream (§5.7) |
| Rate limiting | Redis-backed sliding window, per-customer, fail-open on Redis outage (§5.8) |
| Escrow management | $1K USD-equivalent ETH reserve, 90% in TicketBroker, 10% in operator hot wallet; manual top-up; EscrowMonitor alerts (§8.2) |
| Failure policy | Fail-closed (daemon down or balance zero → 503) |
| Persistence (PayerDaemon) | BoltDB/SQLite (per abstraction doc §13) |
| Wire protocol | `livepeer.payments.v1` — wire-compatible with existing `net.Payment` |
| Key custody | PayerDaemon holds ETH signing key (default custody model) |
| App-side vocabulary | `APIService` (PayerApp specialization), `WorkerNode` (PayeeApp specialization) |

---

## 11. Backlog / v2+

Things explicitly deferred. Track each as its own backlog item so they don't slip:

- **Open node discovery** via Livepeer subgraph / on-chain registry (replaces config-driven allowlist).
- **LocalTokenizer enforcement** (reject node count, use local count as source of truth).
- **Additional endpoints**: `/embeddings`, `/images/generations`, `/audio/transcriptions`, tool/function calling.
- **Enterprise/Postpaid tier** with invoicing, credit policy, SLAs.
- **Auto-reload** for prepaid customers (stripe → balance top-up on threshold).
- **Auto-top-up** of TicketBroker deposit from fiat reserve.
- **Phone/SMS verification** on signup.
- **Per-customer node preferences** (enterprise requirement).
- **Multi-region routing** (latency-based node selection).
- **Usage dashboard** per customer (consumption graphs, model breakdown, cost reports).
- **Reserved free-tier node pool** (dedicated cheap nodes so paid traffic never contends with free).
- **Webhook notifications** to customers (balance low, request failed, usage spike).
- **Model-independent abstraction** (route a single customer request to different underlying models based on load).

---

## 12. Open decisions

Most v1 technical policies are locked (§10). What remains are numbers to monitor, operational setup details to elaborate later, and one tabled topic.

**Monitor and adjust** (starting values chosen as placeholders; first-30-day data drives real numbers):

1. **Customer rate card per tier (§6.2).** Starter/Standard/Pro priced as placeholders. Target: margin ≥ 30% per tier sustained. Emergency reprice below 20% margin for 3 days.
2. **Free-tier token quota.** 100K tokens/month is a starter; revisit based on actual free-user count and per-user cost.
3. **ETH reserve size (§8.2).** $1K for soft launch; scale to $10K+ before general availability based on burn rate.
4. **Node allowlist (§11).** 3–5 nodes at launch; specific WorkerNodes to be selected by the operator. Informs escrow sizing.

**Elaborate later** (locked in direction, details to fill in):

5. **Stripe product/price IDs.** "API Credits" single product with custom amount chosen; exact Stripe configuration (tax settings, webhook endpoints, dispute policy) to be specified during implementation.

**Tabled** (not addressed in v1):

6. **Jurisdiction / compliance.** MSB/VASP/financial-services registrations, KYC thresholds, data protection. Pre-launch legal review required before public launch; not required for private beta. Tabled until operator has a specific jurisdiction commitment.

---

## Appendix A — CustomerLedger data model sketch

```
customer {
  id                  uuid
  email               string
  api_key_hash        string  -- indexed
  tier                enum('free', 'prepaid')
  created_at          timestamp

  -- prepaid tier
  balance_usd_cents   bigint  -- nullable when tier='free'

  -- free tier
  quota_tokens_remaining  bigint  -- nullable when tier='prepaid'
  quota_reset_at          timestamp
  quota_monthly_allowance bigint

  -- common
  rate_limit_tier     string  -- maps to a rate-limit policy
  status              enum('active', 'suspended', 'closed')
}

usage_record {
  id                  uuid
  customer_id         uuid FK
  request_id          uuid  -- matches WorkID on the payment side
  timestamp           timestamp

  model               string
  node_url            string  -- which WorkerNode served it

  -- token counts
  prompt_tokens_reported   int  -- from node
  completion_tokens_reported int
  prompt_tokens_local      int  -- from LocalTokenizer
  completion_tokens_local  int

  -- billing
  cost_usd_cents      bigint  -- what customer was charged
  node_cost_wei       string  -- for reconciliation against PayerDaemon

  -- outcome
  status              enum('success', 'partial', 'failed')
  error_code          string  -- nullable
}

topup {
  id                  uuid
  customer_id         uuid FK
  stripe_session_id   string
  amount_usd_cents    bigint
  status              enum('pending', 'succeeded', 'failed', 'refunded')
  created_at          timestamp
}
```

---

## Appendix B — NodeBook data model sketch

Loaded from config file at startup; refreshed in memory by QuoteRefresher.

```yaml
# nodes.yaml — config-driven in v1
nodes:
  - id: "node-a"
    url: "https://node-a.example.com"
    eth_address: "0x1234..."
    supported_models:
      - "model-small"
      - "model-medium"
    enabled: true
    tier_allowed: ["free", "prepaid"]  # free-tier allowed?
    weight: 100                         # for weighted random routing

  - id: "node-b"
    url: "https://node-b.example.com"
    eth_address: "0x5678..."
    supported_models:
      - "model-medium"
    enabled: true
    tier_allowed: ["prepaid"]          # paid-only node
    weight: 100
```

```
// In-memory augmented by QuoteRefresher + health checks
NodeState {
  id                  string
  config              NodeConfig  // from yaml
  quote {
    ticket_params     TicketParams
    price_info        PriceInfo
    last_refreshed    timestamp
    expires_at        timestamp    // based on TicketParams.expirationBlock
  }
  health {
    status            enum('healthy', 'degraded', 'circuit_broken')
    consecutive_failures  int
    last_success_at   timestamp
    last_failure_at   timestamp
  }
  capacity {
    in_flight_requests  int
    max_concurrent      int
  }
}
```
