---
title: Token audit (LocalTokenizer — observe / audit / enforce)
status: accepted
last-reviewed: 2026-04-24
---

# Token audit

How the bridge verifies WorkerNode-reported token counts against its own tokenizer. **v1 is observation-only** — drift is measured and logged, never enforced. The architecture reference lays out three phases; 0011 ships phase 1.

## Phases

| Phase                        | Behavior                                                                                        | Billing source of truth |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------- |
| **v1 — observe** (this plan) | Tokenize locally; emit drift metric; persist both local and reported counts in `usage_record`   | Node-reported counts    |
| **v1.5 — audit**             | v1 + alert when drift exceeds a threshold sustained over time                                   | Node-reported counts    |
| **v2 — enforce**             | Reject node counts; bill on local tokenizer output; blacklist nodes with persistent large drift | Local counts            |

Moving between phases is an intentional policy change that requires:

- Operator buy-in from node operators (especially for v2, where their revenue depends on local counts).
- Baseline drift data from a period of v1 operation so thresholds in v1.5 aren't guessed.

## Providers

`src/providers/tokenizer.ts` — a minimal interface over encoders:

```ts
interface TokenizerProvider {
  count(encoding: EncodingName, text: string): number;
  preload(encodings: readonly EncodingName[]): void;
  close(): void;
}
```

Default impl (`src/providers/tokenizer/tiktoken.ts`) wraps the official `tiktoken` npm (WASM). Encoders are cached per-process and preloaded at construction time so the first customer request doesn't pay the cold-start cost.

`src/providers/metrics.ts` — new in 0011. No-op default. Exists so emitters compile without a sink; a Prometheus impl lands with ops work.

## Integration points

- **Non-streaming** (`runtime/http/chat/completions.ts`):
  - Prompt: `countPromptTokens(model, messages)` before reserve → feeds `estimateReservation`.
  - Completion: `countCompletionText(model, response.choices[0].message.content)` after node response.
  - Writes `prompt_tokens_local` / `completion_tokens_local` onto `usage_record`.
  - Emits drift metric on success.

- **Streaming** (`runtime/http/chat/streaming.ts`):
  - Prompt: same as non-streaming.
  - Completion: accumulate `delta.content` across forwarded chunks into a single string, `countCompletionText` at stream terminus.
  - `usage_record` + drift metric on the success path.
  - On partial-stream settlement (upstream ends without a usage chunk but tokens were forwarded), the real accumulated count is what gets committed — no more prompt-only billing from the 0008 stopgap.

## Drift metric

```
tokens_drift_percent{node_id, model, direction}    histogram
tokens_local_count{node_id, model, direction}      gauge
tokens_reported_count{node_id, model, direction}   gauge
```

`direction` ∈ `{prompt, completion}` — prompt and completion drift can diverge independently, so they're emitted as separate observations.

```
drift_percent = (reported - local) / local × 100
```

- **Positive**: node reports more than we count (over-reports, possibly for economic reasons).
- **Negative**: node reports fewer than we count (under-reports, possibly due to tokenizer mismatch).
- **±∞**: local is zero, reported is not (should never happen in practice; treat as an instrumentation bug).

Raw counts (`local`, `reported`) are also persisted on `usage_record` so ops can post-hoc aggregate without a time-series DB.

## Model → encoding map

Embedded in `src/config/tokenizer.ts`. v1 maps:

```
model-small   → cl100k_base
model-medium  → cl100k_base
model-large   → cl100k_base
```

This is a conservative OpenAI-family default. Non-OpenAI models (Llama, Mistral, …) need per-family encoder plugins — explicitly out of scope for 0011. Unknown models return `null`; the handler skips audit and relies on node-reported counts for billing.

## Interpreting drift

- **Consistent small drift (≤ 1%)**: tokenizer version mismatch or special-token differences. Expected; no action.
- **Consistent medium drift (1–5%)**: either node using a different encoder (e.g., `o200k_base` instead of `cl100k_base`) or legitimate model-family mismatch. Investigate the mapping.
- **Large positive drift (> 5%)**: node may be over-reporting. Candidate for v2 enforcement when we enable blacklisting.
- **Large negative drift**: node is under-reporting. Revenue leakage for node operator; probably a configuration issue worth surfacing.

Alert thresholds for the v1.5 audit phase are derived from 30 days of v1 observation, not guessed.

## What this doc does NOT cover

- The v2 enforcement trust-model change (node-operator contracts, dispute resolution). Separate design-doc when v2 is scoped.
- Per-request latency budget for tokenization. Benchmarking lives in an ops plan.
- Alert wiring (v1.5): out of scope; ops will decide between Prometheus / Grafana / PagerDuty.
