---
title: Streaming semantics for /v1/chat/completions
status: accepted
last-reviewed: 2026-04-24
---

# Streaming semantics

How the bridge handles `/v1/chat/completions` requests with `stream=true`. Complements `retry-policy.md` (the retry table) and `tiers.md` (reserve/commit/refund).

## Request lifecycle

```
customer POST /v1/chat/completions (stream=true)
  │
  ├── auth preHandler: resolve customer + apiKey
  │
  ├── Zod parse body; resolveTierForModel; reserve (prepaid USD or free-tier quota)
  │
  ├── retry loop (max 3 attempts, pre-first-token only):
  │     pickNode(weighted-random) → createPaymentForRequest → streamChatCompletion(upstream)
  │
  ├── response headers flushed (content-type: text/event-stream)
  │
  ├── for each SSE frame from upstream:
  │     [DONE] → break (streamNormallyEnded=true)
  │     { usage: {...} } → capture; forward iff customer asked for include_usage
  │     { choices[0].delta.content } → forward; mark firstTokenDelivered on non-empty
  │
  ├── settle: if captured usage ⇒ commit actual + usage_record(success)
  │            if no usage, no tokens delivered ⇒ refund + final error frame
  │            if no usage, tokens delivered ⇒ commit prompt portion only, usage_record(partial)
  │
  └── write '[DONE]' → raw.end()
```

## `stream_options.include_usage` injection + stripping

OpenAI emits the final `usage` chunk only when the client sets `stream_options.include_usage=true`. The bridge always forces it **upstream** (to the WorkerNode) so we can bill from the reported counts, then strips it from the **downstream** stream (to the customer) if they didn't originally ask for it.

Concrete rules:

- `customerAskedForUsage = body.stream_options?.include_usage === true` — remembered at entry.
- Upstream body is `{ ...body, stream: true, stream_options: { include_usage: true } }` regardless of caller.
- When a chunk's payload contains a `usage` object: capture; forward to customer only if `customerAskedForUsage`.
- All other chunks forward unchanged.

## Retry window

Retries may fire **only before** any token has been delivered to the customer. Tracked by a single boolean `firstTokenDelivered`, flipped the first time we forward a chunk with non-empty `choices[0].delta.content`. After the flip:

- Mid-stream upstream errors → partial-success settlement (see below).
- Customer disconnect → cancel upstream, settle.
- Missing usage chunk → see "No usage" settlement branch.

Retry table lives in `docs/design-docs/retry-policy.md`.

## Settlement paths

| Condition                                              | Billing action                                                                                                                       | Response to customer                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Stream ended with a `usage` chunk                      | `commit(actual = prompt×inputRate + completion×outputRate)`; `usage_record(status='success')`                                        | Stream as-is (strip usage if not requested)                                                                                    |
| No usage AND no tokens delivered                       | `refund` full reservation                                                                                                            | 5xx shape: no stream started; one error envelope                                                                               |
| No usage AND tokens delivered                          | `commit(prompt-estimate-portion)`; refund completion portion; `usage_record(status='partial', error_code='stream_terminated_early')` | Forward delivered chunks + final error frame `{ error: { type: 'StreamTerminatedEarly', tokens_delivered: N } }` then `[DONE]` |
| Client disconnect mid-stream                           | same as "no usage + tokens delivered" (we bill what we forwarded)                                                                    | Customer is gone; settlement is server-side only                                                                               |
| Upstream 5xx pre-first-token (after retries exhausted) | `refund`                                                                                                                             | 503 `service_unavailable` envelope                                                                                             |

The "prompt-estimate portion" is the character-based estimate introduced in 0007; 0011 replaces it with tiktoken counts.

## Customer disconnect detection

Attached before `runWithRetry`:

```ts
reply.raw.on('close', onClientClose);
req.raw.on('close', onClientClose);
```

Where `onClientClose` calls `abortController.abort()`. That signal is passed through `streamChatCompletion` → `fetch`, which cancels the upstream read. The SSE generator in `providers/nodeClient/fetch.ts` also listens for the signal and calls `reader.cancel()` as a belt-and-suspenders safeguard.

## SSE parser

`eventsource-parser` normalizes CR/LF, handles multi-line `data:` frames, and processes arbitrary byte boundaries. The bridge pushes parsed `{ data: string }` events to an async generator consumed by the handler.

## Out of scope (tracked in tech-debt)

- SSE heartbeat comments (`: keepalive\n\n`) during node pauses. Revisit if client timeouts surface.
- Retry retrofit for the non-streaming (0007) handler — use the same `service/routing/retry.ts` primitive.
- Replacing the character-based prompt estimate in the partial-settle branch with tiktoken (0011).
- Deterministic automated test for the client-disconnect settlement path (implementation is in place; environmental coverage is hard to pin).
