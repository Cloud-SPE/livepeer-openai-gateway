---
title: Retry policy (node dispatch)
status: accepted
last-reviewed: 2026-04-24
---

# Retry policy

When the bridge dispatches a customer request to a WorkerNode and the dispatch fails, this table governs whether we retry, how many times, and on which node.

Implementation: `src/service/routing/retry.ts` (`runWithRetry` + `classifyNodeError`). Consumed by the streaming handler today; retrofit to the non-streaming handler is tracked in tech-debt.

## Table

| Error class                                                 | Retry? | Max | Where          | Notes                                                  |
| ----------------------------------------------------------- | ------ | --- | -------------- | ------------------------------------------------------ |
| Network error / timeout contacting node, pre-first-token    | Yes    | 2   | Different node | Short backoff (caller's choice; default 0 ms)          |
| 5xx from node, pre-first-token                              | Yes    | 2   | Different node | Same                                                   |
| "Inference failure" 5xx (OOM, model crash), pre-first-token | Yes    | 1   | Different node | Node-specific; informed by metrics later               |
| 4xx from node (validation, auth, context-length)            | **No** | —   | —              | Surface as-is to customer                              |
| Payment insufficient (node rejects payment)                 | Yes    | 1   | —              | Force quote refresh, then retry once                   |
| **Streaming: any error after first token delivered**        | **No** | —   | —              | Partial-success response; see `streaming-semantics.md` |
| `ErrTicketParamsExpired` from PayeeDaemon                   | Yes    | 1   | Same node      | Force quote refresh, retry once                        |

"First token delivered" is the **hard** boundary. Once a chunk with non-empty `choices[0].delta.content` has crossed the wire to the customer, there are no retries — the bridge commits to the node and settles based on what's actually delivered.

## Why no retries after first token

- **Customer-observable content cannot be "undone".** Silently swapping to a new node after the first token means the customer sees mixed generations from two different models (or the same model with different state), which is worse than a partial-success error.
- **Billing integrity.** Mid-stream retries complicate reconciliation between CustomerLedger, PayerDaemon, and TicketBroker. Keeping retries pre-first-token preserves one-session-per-customer-request semantics on the payment side.

## Hops to a different node, not the same one

Unless the error is `ErrTicketParamsExpired` (which is quote freshness, not node health), retries hop to a **different** WorkerNode. Hammering the same node rarely helps and converts a node-specific outage into a latency-amplification event.

## Retry + NodeBook interaction

`runWithRetry` calls `pickNode` on each attempt. `pickNode` applies NodeBook's weighted-random selection over the healthy admission set — which already excludes `circuit_broken` nodes. Each attempt therefore picks from the currently healthy pool, which may narrow over the course of a single request.

If no healthy nodes remain partway through retries, `NoHealthyNodesError` surfaces and the customer sees 503 `service_unavailable`.

## Max attempts = 3 (streaming handler default)

Three attempts gives us the plan's "up to 2 retries" (attempt 1 + 2 retries = 3 total). The streaming handler configures this via the `MAX_RETRY_ATTEMPTS` constant.

## Backoff

None. At v1 scale (3–5 nodes, rare failures), the value of exponential backoff between retries is marginal and the latency cost is customer-visible. If operational data shows retry storms, add a simple 100/500 ms staircase before exceeding the second retry.

## What this doc does NOT cover

- Retries on the payment side (PayerDaemon). Those are a client-side concern of `providers/payerDaemon/grpc.ts` (unix-socket disconnect → reconnect-and-retry) and have their own design-doc once they exist.
- Application-level retries by the customer's OpenAI SDK. Customers retry customer-visible errors at their discretion; we don't assume anything about their policy.
