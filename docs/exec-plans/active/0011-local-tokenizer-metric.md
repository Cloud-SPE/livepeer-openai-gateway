---
id: 0011
slug: local-tokenizer-metric
title: LocalTokenizer in metric-only mode
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Implement `service/tokenAudit`: tokenize prompts and completions locally using the right encoder per model, and emit drift metrics comparing local counts vs. WorkerNode-reported counts. v1 is observation-only; no enforcement, no billing impact.

Depends on: `0007-chat-completions-nonstreaming` (integration point).

## Non-goals

- No enforcement. `enforce` mode is a v2 plan.
- No blacklisting based on drift. Operators inspect the dashboard; no automated action.
- No alerting on drift. `v1.5 (audit)` phase adds alerts.

## Approach

- [ ] `providers/tokenizer` interface: `encode(model, text) → tokens[]`, `countTokens(model, text) → number`
- [ ] Default impl: `tiktoken` for OpenAI-family encodings (`cl100k_base`, `o200k_base`)
- [ ] Plugin stub for Llama-family (not wired in v1)
- [ ] Prompt tokenization: count before sending (cheap; we have the prompt)
- [ ] Completion tokenization:
  - Non-streaming: count full response body
  - Streaming: accumulate as chunks pass through
- [ ] Store `local_prompt_tokens`, `local_completion_tokens` alongside reported counts in usage_record
- [ ] Emit `tokens_drift_percent{node, model}` metric
- [ ] Dashboard query: per-node drift over time (documented; actual dashboard config per operator)
- [ ] Author `docs/design-docs/token-audit.md` — phases (observe → audit → enforce), migration path

## Decisions log

_(empty)_

## Open questions

- Tokenizer library choice: `tiktoken` (C++ bindings) vs `js-tiktoken` (pure JS). Performance difference matters at scale; lean `tiktoken`.
- Model → encoding mapping: hard-coded table or derived from model metadata? Start hard-coded; table in `config/`.
- What about unknown models? Log + skip audit (no drift metric).
- Drift metric granularity: per request? per 1000-token bucket? Per request is fine.

## Artifacts produced

_(to be populated on completion)_
