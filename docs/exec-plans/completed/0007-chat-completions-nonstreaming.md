---
id: 0007
slug: chat-completions-nonstreaming
title: /v1/chat/completions — non-streaming
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Implement the non-streaming path for `/v1/chat/completions`. This is the first end-to-end customer-facing endpoint and validates that all prior plans (auth → ledger → nodes → payments) compose correctly.

Depends on: `0002-types-and-zod`, `0003-customerledger`, `0004-auth-layer`, `0005-nodebook`, `0006-payer-client`.

## Non-goals

- No streaming. That's `0008-chat-completions-streaming`.
- No retry-policy implementation yet — handle only "first node succeeds" case; retry/failover comes with 0008 or its own plan.
- No rate-limit enforcement (beyond auth-layer coarse check). `0009-rate-limiter`.
- No LocalTokenizer. `0011-local-tokenizer-metric`.

## Approach

- [ ] Handler at `src/runtime/http/chat/completions.ts` for non-streaming requests
- [ ] Request validation: Zod parse on body (required per core-belief §4)
- [ ] AuthLayer: resolve customer
- [ ] CustomerLedger: reserve `max_tokens × customer_rate_for_tier`
- [ ] Router: pick a WorkerNode from NodeBook matching model and tier
- [ ] `service/payments`: CreatePayment with reserved max_tokens budget
- [ ] Dispatch to WorkerNode (HTTP client in `providers/` — new provider or inline?)
- [ ] Parse node response via Zod
- [ ] CustomerLedger: commit actual cost from `response.usage.total_tokens`
- [ ] Store usage_record (success/partial/failed)
- [ ] Return OpenAI-compatible response to customer
- [ ] Error shapes: match OpenAI's error envelope format
- [ ] Integration test using the official OpenAI SDK against the running bridge

## Decisions log

### 2026-04-24 — Extend `NodeClient` provider with `createChatCompletion`

Reason: Node HTTP already lives behind the `NodeClient` provider (0005 for `/health` and `/quote`). Adding the `/v1/chat/completions` call to the same interface keeps all worker-node HTTP in one place, one test surface, one swap point. A separate `WorkerNodeHttpClient` provider would duplicate boilerplate with no reuse win.

### 2026-04-24 — Routing policy: weighted-random with first-fit tiebreak

Reason: NodeBook already returns the admission set sorted by descending weight. A weighted-random pick distributes load per operator intent without requiring any shared in-flight state. First-fit (always take the top-weighted node) hot-spots on one node. Least-in-flight needs cross-request state that doesn't pay off at 3–5 nodes. The `rng: () => number` is injectable so tests can seed a deterministic distribution.

### 2026-04-24 — `WorkId` = `{customer_id}:{uuid-v4}`, generated at handler entry

Reason: Matches plan. One id flows from handler → reservation → payment → node request header → usage_record. Prefixed with `customer_id` so the PayerDaemon audit log and the bridge's own logs correlate without extra lookup tables.

### 2026-04-24 — Error envelope matches OpenAI's exact shape

Reason: A drop-in OpenAI SDK integration (PRODUCT_SENSE.md top goal) means the error shape must match byte-for-byte where the SDK inspects it. Reuse `ErrorEnvelopeSchema` from 0002 with OpenAI-compatible `code` and `type` strings. Mapping is centralized in `src/runtime/http/errors.ts` so every handler emits the same shape.

### 2026-04-24 — Missing `response.usage` from node: fail the request (503) + refund

Reason: Without `usage` we cannot bill correctly. Backfilling would risk mis-charging either direction; charging for `max_tokens` would overcharge customers for node misconfiguration. Instead we treat a missing-usage response as an upstream contract violation — classify as `service_unavailable`, refund the reservation, surface 503 to the customer, and emit a node-level metric so operators can triage.

### 2026-04-24 — Pricing config: `src/config/pricing.ts` with v1 defaults embedded

Reason: v1 ships with the Starter / Standard / Pro rate card from `docs/design-docs/pricing-model.md`. Hard-coding the defaults keeps the binary self-contained; when ops needs to reprice without redeploying, a file-based override lands in a follow-on plan (tracked in tech-debt). Model→tier mapping is a small dictionary — a dedicated config file is overkill for three tiers.

### 2026-04-24 — Reservation math: conservative upper bound (char-based estimate until 0011 lands)

Reason: Without LocalTokenizer (0011), we can't count prompt tokens locally. The reservation must upper-bound actual cost so the customer never commits beyond what they can afford. Formula:

```
prompt_estimate  = ceil(sum(message.content.length) / 3)
max_completion   = max_tokens ?? (tier === 'free' ? 1024 : 4096)
est_cents        = ceil(prompt_estimate × inputRate_cents + max_completion × outputRate_cents)
```

Commit uses actual `prompt_tokens + completion_tokens` from the node's `usage`, so the customer is billed real cost and excess is refunded. 0011 swaps the estimator for tiktoken — tracked in tech-debt.

## Open questions

- Per-model context-length enforcement (e.g., 8K cap on model X): deferred. For v1 we rely on the node to reject oversized inputs; we enforce `max_tokens` caps per tier in the handler.
- Timeout tuning on the node HTTP call: default 60 s for non-streaming; override per-tier or per-model in a later plan if we see tail-latency issues.

## Artifacts produced

_(to be populated on completion)_
