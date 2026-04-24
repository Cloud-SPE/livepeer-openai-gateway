---
id: 0008
slug: chat-completions-streaming
title: /v1/chat/completions — streaming
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Implement the streaming path for `/v1/chat/completions`: SSE proxying, `stream_options.include_usage` injection/stripping, mid-stream cancellation, partial-success semantics on failure, retry policy.

Depends on: `0007-chat-completions-nonstreaming`.

## Non-goals

- No non-streaming regressions — handler must remain 100% backwards compatible.
- No top-up-mid-stream flow. Customer balance is reserved upfront; no in-flight refills in v1.

## Approach

- [ ] Detect `stream=true` in request body; route to streaming handler
- [ ] Inject `stream_options.include_usage=true` if customer didn't set it; remember this decision for the stripping step
- [ ] Reserve `max_tokens × customer_rate` in CustomerLedger
- [ ] Open SSE proxy to WorkerNode
- [ ] Forward chunks: parse each, re-emit to customer
- [ ] LocalTokenizer in pass-through mode: count tokens as they flow (metric only)
- [ ] On terminal chunk (one containing `usage`): capture final token count; strip the usage chunk from the customer's stream if they didn't ask for it
- [ ] On `data: [DONE]`: commit actual cost, refund difference
- [ ] Customer disconnect mid-stream: cancel upstream, commit delivered tokens only, refund rest
- [ ] Network failure to node mid-stream: commit delivered tokens, surface `{error: stream_terminated_early, tokens_delivered: N}` to customer, no retry
- [ ] Implement retry policy per `docs/design-docs/retry-policy.md` (to be authored here) — retries only when no tokens delivered
- [ ] Integration test with OpenAI SDK, including cancel scenarios
- [ ] Author `docs/design-docs/streaming-semantics.md`, `docs/design-docs/retry-policy.md`

## Decisions log

### 2026-04-24 — SSE parser: `eventsource-parser`

Reason: Mature, zero-dep, handles CR/LF normalization, comments, multi-line `data:` frames, and incremental byte chunks. Rolling our own parser is a time sink with edge cases that fail in subtle ways. Library is tiny and has a single push-based API.

### 2026-04-24 — Retry policy (authored in `docs/design-docs/retry-policy.md`)

Reason: Per the architecture reference §5.7. Retries happen only **before** any token is delivered to the customer. Once the first forwarded chunk with non-empty `choices[0].delta.content` hits the wire, the stream is committed — no retry, no silent node swap. Network errors and 5xx pre-first-token may hop to a different node (max 2). `ErrTicketParamsExpired` triggers a same-node quote refresh + one retry. 4xx is surfaced as-is. Retry machinery lives in `src/service/routing/retry.ts` and is consumed by the streaming handler; non-streaming retrofit tracked in tech-debt.

### 2026-04-24 — First-token marker via a `firstTokenDelivered: boolean`

Reason: Simplest possible signal. Flag flips the first time we forward a chunk containing non-empty `choices[0].delta.content` to the customer. Retry eligibility reads this; commit-math uses it to decide "partial success" vs. "no delivery" branches.

### 2026-04-24 — Customer disconnect via `reply.raw.on('close', …)` + `AbortController`

Reason: Fastify exposes the underlying Node stream. Subscribing to `close` on the response raw stream fires on both normal end and client disconnect. We distinguish via a `streamCompletedNormally` flag. On abnormal close: abort the upstream read loop, commit delivered tokens only, refund the rest.

### 2026-04-24 — `stream_options.include_usage` injection / stripping

Reason: We need the final usage chunk to bill correctly; OpenAI emits it only when `include_usage=true`. So we always force-set it upstream, remember whether the customer asked for it, and strip the usage chunk on the way out if they didn't. The chunk shape is stable: last data frame before `data: [DONE]` carries `choices: []` and `usage: { prompt_tokens, completion_tokens, total_tokens }`.

### 2026-04-24 — Missing upstream usage chunk — split behavior by delivered-state

Reason: Plan asked a yes-or-no question; the honest answer depends on whether we forwarded any tokens.

- **No tokens delivered** → treat as node contract violation. Full refund, emit a 5xx-style error envelope (stream not yet started). Same semantics as non-streaming 0007 path.
- **Tokens delivered, stream ended without a usage chunk** → the customer already got content; cannot claw that back. Commit the prompt-estimate portion only (stopgap billing until 0011 provides tiktoken-based completion counts). Refund the full completion portion of the reservation. Emit `stream_terminated_early` semantics via final SSE event. Logged in tech-debt so 0011 can refine the completion count.

### 2026-04-24 — Commit / refund atomic with `usage_record` insert at stream terminus

Reason: Plan default. Existing `service/billing.commit` already caps `actual` at `reserved` and refunds the delta inside the same transaction as `usage_record`. "Partial commit" is just `commit(reservationId, actualCostCents = billedPortion)`. No new billing primitive.

## Open questions

- Per-handler streaming deadline: should the whole stream have a max wall-clock window (say 5 min) beyond which we force-terminate and commit? Lean yes but defer the knob to ops config.
- SSE heartbeats on idle: some clients expect `: keepalive` comments when the node pauses mid-generation. Not in scope for 0008; revisit if we see client timeouts.

## Artifacts produced

_(to be populated on completion)_
