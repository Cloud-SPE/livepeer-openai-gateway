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

_(empty)_

## Open questions

- HTTP client to WorkerNode: own provider (`providers/httpClient`) or inline fetch? Lean provider for testability.
- Where exactly does workID get generated? `{customer_id}:{uuid}` at handler entry; flows through to payments.
- Error shape fidelity: OpenAI uses specific error codes (`invalid_api_key`, `rate_limit_exceeded`, `context_length_exceeded`). Match precisely.
- `response.usage.total_tokens` missing: do we trust, backfill from prompt+completion, or 500?

## Artifacts produced

_(to be populated on completion)_
