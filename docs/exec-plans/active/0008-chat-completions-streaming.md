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

_(empty)_

## Open questions

- SSE parser: roll our own (simple) or use a library (`eventsource-parser`)? Lean library for edge cases.
- How do we detect "no tokens delivered yet" for retry decisions? Track a counter keyed off first valid `choices[0].delta.content` byte.
- Customer-facing error when we inject include_usage but node doesn't honor it: 500 or partial-success? 500 — this is a node misconfiguration, we can't bill.
- Reservation refund timing: immediately on stream end or end-of-transaction with the usage_record write? Atomic with usage_record.

## Artifacts produced

_(to be populated on completion)_
