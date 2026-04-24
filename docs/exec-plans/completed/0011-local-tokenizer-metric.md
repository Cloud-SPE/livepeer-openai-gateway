---
id: 0011
slug: local-tokenizer-metric
title: LocalTokenizer in metric-only mode
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Implement `service/tokenAudit`: tokenize prompts and completions locally using the right encoder per model, and emit drift metrics comparing local counts vs. WorkerNode-reported counts. v1 is observation-only; no enforcement, no billing impact.

Depends on: `0007-chat-completions-nonstreaming` (integration point).

## Non-goals

- No enforcement. `enforce` mode is a v2 plan.
- No blacklisting based on drift. Operators inspect the dashboard; no automated action.
- No alerting on drift. `v1.5 (audit)` phase adds alerts.

## Approach

- [x] `providers/tokenizer` interface: `count(encoding, text) → number`, `preload(encodings)`, `close()`. (No `encode` — callers don't need token arrays.)
- [x] Default impl: `tiktoken` (WASM) with per-encoding cache + preload at construction.
- [ ] Plugin stub for Llama-family — deferred; explicit tech-debt entry.
- [x] Prompt tokenization: `countPromptTokens(model, messages)` before reserve; feeds `estimateReservation`.
- [x] Completion tokenization:
  - Non-streaming: count full response body after node reply.
  - Streaming: accumulate `delta.content` across forwarded chunks; count once at stream end.
- [x] Store `prompt_tokens_local` + `completion_tokens_local` alongside reported counts in `usage_record` (columns provisioned in 0003).
- [x] Emit `tokens_drift_percent{node_id, model, direction}` histogram plus paired `tokens_local_count` / `tokens_reported_count` gauges.
- [x] Providers: new `MetricsSink` interface with no-op default. (Prometheus sink is tech-debt.)
- [x] Author `docs/design-docs/token-audit.md` — phases (observe → audit → enforce), drift metric, integration points, interpretation guide.

## Decisions log

### 2026-04-24 — Tokenizer: official `tiktoken` npm (WASM)

Reason: WASM hot path is meaningfully faster than pure-JS `js-tiktoken` on large prompts, and we tokenize on every request. Cold-start cost (first encode loads the encoding) is mitigated by preloading encoders at service construction and keeping them cached for the process lifetime.

### 2026-04-24 — New `providers/metrics` (interface + no-op default)

Reason: The architecture reference already anticipates a `MetricsSink`. 0011 needs to emit `tokens_drift_percent`, so we introduce the provider now — `counter` / `gauge` / `histogram` with labels, no-op default. A Prometheus sink lands with an ops plan; until then, a no-op keeps the API clean without a persistent dep.

### 2026-04-24 — Model → encoding map embedded in `src/config/tokenizer.ts`; unknown models skip audit

Reason: v1 maps `model-small` / `model-medium` / `model-large` to `cl100k_base` as a conservative OpenAI-family default. Per-family encoder plugins (Llama tokenizer, etc.) are future work. Unknown models: log WARN + skip audit (no drift emitted); billing stays on node-reported counts. This is safer than billing on best-guess local counts for a model we don't recognize.

### 2026-04-24 — Drift metric is per-request, labeled `{ node_id, model, direction }`

Reason: Per-request granularity is sufficient at v1 volume. Direction distinguishes prompt vs. completion drift (they can drift independently — some nodes inflate completion counts differently than prompts). Raw counts persisted on `usage_record.prompt_tokens_local` / `.completion_tokens_local` for post-hoc analysis.

### 2026-04-24 — Replace 0007's char-based reservation estimator with tokenizer-based

Reason: 0007 shipped `Math.ceil(charCount / 3)` explicitly as a stopgap. With tiktoken available, reservation math can be tight — prompt reserved = actual prompt tokens × input rate, completion reserved = max_tokens × output rate. Small risk: borderline low-balance customers who were under-estimating may now see 402. The correct behavior is to reserve what we'll actually use.

### 2026-04-24 — Streaming accumulation replaces `tokensDeliveredApprox`

Reason: 0008 used a char-based running counter as a stopgap. Now each forwarded chunk's `delta.content` goes through the tokenizer; the accumulated count is the real completion count. On partial-stream settlement (upstream ends without a usage chunk, tokens already delivered), we now commit the real completion portion instead of prompt-only, closing the 0008 tech-debt entry.

### 2026-04-24 — Observation-only in v1 (no enforcement, no alerting)

Reason: Plan is emphatic and matches the architecture reference phases (observe → audit → enforce). Enforcement would require operator buy-in from node operators and a design change to the trust model; not a v1 scope call. Alerts on sustained drift > threshold are a v1.5 "audit" phase item.

## Open questions

- Per-family encoder plugin (Llama tokenizer) — explicitly out of scope; node operators running non-OpenAI-family models get a skipped audit and billing continues unaffected.
- Tokenizer cache eviction: v1 keeps all loaded encoders for process lifetime (small memory cost). If the encoding set grows unboundedly we'll revisit.

## Artifacts produced

- Providers: `src/providers/tokenizer.ts` (interface) + `src/providers/tokenizer/tiktoken.ts` (WASM-backed default with per-encoding cache) + `src/providers/metrics.ts` (interface) + `src/providers/metrics/noop.ts` (no-op default).
- Config: `src/config/tokenizer.ts` — model→encoding map (`model-small`/`medium`/`large` → `cl100k_base`), `resolveEncodingForModel`, `knownEncodings`.
- Service: `src/service/tokenAudit/index.ts` — `createTokenAuditService`, `countPromptTokens`, `countCompletionText`, `emitDrift`, `computeDriftPercent`.
- Pricing hook: `estimateReservation` now accepts an optional `TokenAuditService`; when present uses the tokenizer count; char-based fallback is retained for callers that don't pass one (0007 stopgap kept for back-compat).
- Non-streaming handler: `src/runtime/http/chat/completions.ts` optionally depends on `tokenAudit`; writes `prompt_tokens_local` / `completion_tokens_local` onto `usage_record` and emits the drift metric on success.
- Streaming handler: `src/runtime/http/chat/streaming.ts` accumulates `delta.content` across forwarded chunks, uses real completion count on partial-stream settlement (replacing 0008's prompt-only stopgap), and emits the drift metric on success.
- Tests (210 total, 12 new for 0011; 92.16% stmt / 81.17% branch / 95.14% func / 92.16% line): `src/service/tokenAudit/tokenAudit.test.ts` (9 tests — drift math edges, unknown-model skip, known-string cl100k counts, emitDrift produces paired histogram+gauges), `src/config/tokenizer.test.ts` (3 tests).
- Design-doc: `docs/design-docs/token-audit.md` (`status: accepted`) — phases, drift metric, integration points, interpretation guide, threshold rationale.
- Tech-debt: Llama-family tokenizer plugin; v1.5 drift alerting; v2 enforcement (with trust-model design-doc); Prometheus metrics sink replacing the no-op.
