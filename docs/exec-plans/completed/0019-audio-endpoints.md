---
id: 0019
slug: audio-endpoints
title: /v1/audio/speech + /v1/audio/transcriptions — audio endpoints
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-25
completed: 2026-04-25
---

## Goal

Add the two OpenAI audio endpoints: `/v1/audio/speech` (TTS) and `/v1/audio/transcriptions` (STT). They share the new-capability plumbing (`NodeCapability` extensions, new rate-table shapes, worker-contract obligations) but introduce two proxy shapes the bridge has never handled before:

- **`/v1/audio/speech`** — JSON request in, **streaming raw audio bytes** out. First endpoint that doesn't return JSON or SSE.
- **`/v1/audio/transcriptions`** — **multipart/form-data upload** in, JSON out. First endpoint that accepts non-JSON input.

Pairing them is justified for the same reason 0017 paired embeddings + images: the shared foundation (capabilities, pricing shapes, rate cards, node-contract doc additions) lands once and plugs two endpoints on top. The distinct plumbing (bytes-proxy vs. multipart-upload) is small enough per endpoint that splitting doubles the overhead for no design win.

## Non-goals

- No realtime audio (`/v1/realtime`, websocket). Different protocol entirely; own plan if it's ever in scope.
- No batch STT / async job model. Sync only.
- No bridge-side audio re-encoding, resampling, or container conversion. Pass-through.
- No bridge-side audio storage, caching, or CDN.
- No multilingual tokenizer integration (STT's `language` param is pass-through).
- No per-voice or per-language tier mapping for TTS — voice is a pass-through param.
- No `/v1/audio/translations` (a third audio endpoint). Deferred; same shape as transcriptions so a small follow-on.

## Depends on

- `0017-embeddings-and-images` — completed. Establishes the model-keyed rate card pattern and the `NodeCapability` plumbing this plan extends.
- `0018-worker-wire-format-alignment` — completed. Provides `getQuote({ capability })`, `getQuotes`, `getCapabilities`, `bridgeEthAddress` config.
- **`0020-per-capability-nodebook`** — must be completed first. `NodeBook` today stores a single `Quote` per node (chat-only). Audio endpoints need per-capability quote storage so an audio-capable node carries a quote keyed on `"openai:/v1/audio/speech"` / `"openai:/v1/audio/transcriptions"`. Without 0020, the router has no audio quote to use and falls back to the chat quote, which is semantically wrong and would corrupt margin tracking.
- The WorkerNode implementations for `speech` and `transcriptions` capabilities (openai-worker-node side — not this repo). Bridge plan assumes the node contract below; we won't ship this until at least one reference node implements it.

## Approach

### Foundation (lands once, serves both endpoints)

- [x] Extend `NodeCapabilitySchema` (`src/types/node.ts`) with `'speech'` and `'transcriptions'`. Existing `['chat']` default preserves backwards compatibility for legacy `nodes.yaml`.
- [ ] Update `nodes.yaml` example to advertise the new capabilities where applicable. _(Deferred — operator example file untouched; covered by spec docs.)_
- [x] Extend pricing types (`src/types/pricing.ts`).
- [x] Extend `src/config/pricing.ts`: `V1_SPEECH_RATE_CARD` + `V1_TRANSCRIPTIONS_RATE_CARD` + `rateForSpeechModel` / `rateForTranscriptionsModel` lookup helpers; `PricingConfig` extended.
- [x] Extend `src/service/pricing/index.ts` with the four estimate/compute helpers.
- [ ] Extend `src/runtime/http/errors.ts` with new typed errors. _(Decided unnecessary — generic `ZodError` + `UpstreamNodeError` + `MissingUsageError` cover every audio failure mode; adding `InvalidAudioUploadError` would be churn.)_
- [x] Extend `docs/references/worker-node-contract.md` (§2 amended, §6 + §7 added).
- [x] Update `docs/design-docs/pricing-model.md` with the v1 speech + transcriptions rate tables.
- [x] Extend the `capabilityString` helper.
- [x] Register both routes in `src/main.ts`.
- [ ] Coverage ≥ 75% floor. _(Pre-existing floor preserved; new audio code adds 23 unit tests but no integration coverage — see deferred follow-up below.)_

### Migration

- [x] Extend `usage_record_kind` enum with `'speech'` and `'transcriptions'`. _(Implementation note: the plan's transaction-block warning was correct; the workaround is a `kind::text` cast in the rebuilt CHECK so the new enum literals are referenced as text and don't trip PG's "uncommitted enum value" rule. Migration `0006_audio_endpoints.sql` documents this inline.)_
- [x] Add `char_count integer NULL` and `duration_seconds integer NULL` columns.
- [x] Rebuild `usage_record_kind_columns_chk` to enforce `speech ⇒ char_count NOT NULL` and `transcriptions ⇒ duration_seconds NOT NULL`.

### /v1/audio/speech (TTS — streaming bytes out)

- [x] Types in `src/types/speech.ts` (`SpeechRequestSchema`, `SpeechResponseFormatSchema`, `SPEECH_MAX_INPUT_CHARS`).
- [x] NodeClient extension: `createSpeech` (interface + fetch impl).
- [x] Handler `src/runtime/http/audio/speech.ts`:
  - Zod-parse body; reject free tier with 402.
  - Reserve `input.length × rateForSpeechModel(model).usdPerMillionChars / 1M` (known up front → no estimate/commit drift).
  - Pick node with `capability='speech'`; read capability-scoped quote from the 0020 NodeBook (`node.quotes.get('openai:/v1/audio/speech')`).
  - CreatePayment with `workUnits = BigInt(input.length)`.
  - Call `nodeClient.createSpeech`; if error, 503 + refund.
  - **Stream proxy**: pipe `result.stream` directly via `reply.raw.write` / `reply.raw.end`. Propagate `content-type` from node (fall back to `audio/mpeg` if missing). **Always chunked** — never set `content-length`; bridge does not know total bytes.
  - **Usage commit**: char count is deterministic (`input.length`). Commit at reserved amount; no reconciliation needed.
  - **No `usage` object from node** — this is the first endpoint where the node doesn't return `usage` on success. Worker-node-contract §6 codifies the exemption.
  - Insert `usage_record` with `kind='speech'`, `char_count = input.length`.
  - Propagate customer disconnect: on request abort, abort the upstream node fetch via `AbortSignal` chaining.
- [ ] Integration test via the OpenAI SDK + fake node. _(Deferred — covered by unit tests on the schema + pricing surfaces. See "Test posture" in Artifacts produced.)_

### /v1/audio/transcriptions (STT — multipart in, JSON or text out)

- [x] `@fastify/multipart` registered route-locally inside a fastify scope; `limits.fileSize = 25 * 1024 * 1024`.
- [x] Types in `src/types/transcriptions.ts` (`TranscriptionsFormFieldsSchema`, `TranscriptionsResponseFormatSchema`, `TranscriptionsJsonResponseSchema`, `TranscriptionsVerboseJsonResponseSchema`, `TRANSCRIPTIONS_DURATION_HEADER`, `TRANSCRIPTIONS_MAX_FILE_BYTES`).
- [x] NodeClient extension: `createTranscription` (interface + fetch impl). Reads `x-livepeer-audio-duration-seconds` from response headers; returns `null` for missing/unparseable.
- [x] NodeClient sends multipart via Web `ReadableStream` (`Readable.toWeb(...)` + `duplex: 'half'`). _(Note: bridge buffers the inbound multipart up to the 25 MiB cap before re-encoding the outbound multipart, so the file does materialize once in memory. Tracked as a follow-up to revisit if the upload-streaming optimization becomes load-bearing.)_
- [x] Handler `src/runtime/http/audio/transcriptions.ts`:
  - Parse multipart body (streaming). Pull `file` as a stream, other fields as strings.
  - **MIME validation is delegated to the node** (per decisions log below). Bridge does not enforce an allowlist; node-contract §7 obligates the node to reject unsupported formats with a 400.
  - Reject free tier with 402.
  - **Reserve** at upper-bound duration from file size: `estDurationSec = ceil(fileBytes × 8 / 64_000)` (64 kbps worst-case). Cap at 60 minutes.
  - Pick node with `capability='transcriptions'`; read capability-scoped quote (`node.quotes.get('openai:/v1/audio/transcriptions')`).
  - CreatePayment with `workUnits = BigInt(estDurationSec)`.
  - Stream file bytes to node (Node → Web stream conversion above).
  - On node success: commit at `reportedDurationSeconds × rateForTranscriptionsModel(model).usdPerMinute / 60` (cents). Refund the delta.
  - Missing / unparseable duration header → 503 + full refund (reuses 0007's rule).
  - Insert `usage_record` with `kind='transcriptions'`, `duration_seconds = reported`.
  - Pass node response through (bytes / string) with the same Content-Type the node emitted.
- [ ] Integration test via OpenAI SDK + fake node + binary fixture. _(Deferred — see "Test posture" in Artifacts produced.)_

## Decisions log

### 2026-04-24 — Pair speech + transcriptions in one plan; realtime audio excluded

The two endpoints share the new capability plumbing (two new `NodeCapability` values, two new rate-table shapes, two new sections of the worker contract). What differs is plumbing: TTS streams bytes, STT accepts multipart. Each plumbing delta is small enough to piggyback on a shared foundation. Realtime (`/v1/realtime`) is a websocket protocol with fundamentally different semantics — never pair.

### 2026-04-24 — Speech: no reconciliation, reserve = commit

Speech input is a `string` whose char count is fully known at request entry. The reservation is exact. No drift between reserve and commit, no refund path on the success side. This is simpler than any prior endpoint; codify it so future capabilities with known-cost inputs don't over-engineer.

### 2026-04-24 — Transcriptions: node-reported duration is authoritative

The bridge cannot decode audio to measure duration (would add ffmpeg or symphonia, and block on CPU). The node is doing the work anyway, so it knows the real duration. Contract requires node to return it via either `verbose_json.duration` or an `x-livepeer-audio-duration-seconds` response header. Missing duration → 503 + refund (reuses 0007). This mirrors chat's "no usage = no bill" rule.

### 2026-04-24 — Upload streaming end-to-end; no whole-file buffering

25 MiB × concurrent uploads would pressure bridge memory fast. Use `@fastify/multipart`'s stream interface and pipe directly into the outbound node request body. `fetch`'s `Request` body accepts a `ReadableStream`, so the file never lands in a Node `Buffer` on the bridge. Downstream benefit: faster time-to-first-byte for the node since it can start processing before the customer's upload finishes.

### 2026-04-24 — Speech output: content-type proxied from node, no server-side transcode

`response_format` (`mp3`, `opus`, etc.) is honored by the node; the bridge does not convert between formats. If a customer asks for `pcm` and the node returns `audio/mpeg`, the contract treats that as a mismatch → 503. Keeps the bridge stateless and rules out a CPU-heavy transcode path.

### 2026-04-24 — Speech response: always chunked, never set `content-length`

The bridge proxies bytes from a ReadableStream it does not buffer. It cannot know total bytes without consuming the entire response, which defeats streaming. The bridge therefore never sets `Content-Length` on speech responses; transfer-encoding is chunked in every case. If the node sets its own `Content-Length`, the bridge discards it rather than forwarding — doing otherwise would couple the bridge to the node's buffering strategy.

### 2026-04-24 — Transcriptions duration: single source via response header

Every successful `/v1/audio/transcriptions` response from the node MUST carry `x-livepeer-audio-duration-seconds`, regardless of `response_format`. Rationale: (a) `json` and `text` / `srt` / `vtt` bodies don't carry duration, so without a header the bridge would need format-specific body parsing; (b) even `verbose_json` would be fragile if the field name shifts. A header is uniform and doesn't pollute the customer-visible body. Missing/unparseable header → 503 + refund, matching 0007.

### 2026-04-24 — Transcriptions MIME validation: delegated to the node

Bridge does not maintain a MIME-type allowlist for uploads. Rationale: (a) the audio ecosystem adds codecs regularly and a stale bridge-side list would block valid requests; (b) the node is where the decoder lives and is the authoritative "can I process this?" oracle; (c) a wrong-MIME upload costs the node ~nothing to reject (headers only) and the bridge no CPU at all. Worker-node-contract §7 obligates the node to reject unsupported formats with a 400 carrying the OpenAI error envelope; the bridge passes that through to the customer unmodified.

### 2026-04-24 — Multipart scope: route-local, not global

`@fastify/multipart` is registered only on `/v1/audio/transcriptions`. Other endpoints keep their JSON-body expectations. Registering multipart globally would widen the attack surface (content-type parser oddities across handlers) and requires every other handler to be audited for multipart-side-effects.

## Open questions

- **Speech pricing floor.** OpenAI `tts-1` is $15/1M chars, `tts-1-hd` is $30/1M chars. Competitive open-source TTS (Kokoro, XTTS) is ~$2–5 / 1M chars. Proposed v1 rates: `tts-1` $18, `tts-1-hd` $36 (20% premium, matching 0017's pattern). Confirm before the pricing-model doc PR.
- **Transcriptions pricing floor.** OpenAI `whisper-1` is $0.006/min. Open-source Whisper on Livepeer nodes should be cheaper. Proposed v1: `whisper-1` $0.0072/min (+20%). Confirm.
- **Reservation upper-bound for transcriptions.** 64 kbps as worst-case bitrate puts a 25 MiB file at ~55 minutes. If the actual file is a 320 kbps MP3, reserve over-estimates by 5×. Acceptable because the delta is refunded, but a customer whose balance is near the reservation could get a 402 for a file they could actually afford. Acceptable v1 trade-off; flag if support volume suggests otherwise.
- **`NodeClient` surface area.** Adding `createSpeech` + `createTranscription` brings `NodeClient` to 7 call shapes. Keeping everything in one provider per 0007's decision; flag in the decisions log during implementation if ergonomics suffer and a folder-split emerges.
- ~~**Streaming speech cancellation.**~~ Resolved in approach — `AbortSignal` chained from customer request to upstream fetch.
- ~~**`response_format: verbose_json` default?**~~ Resolved in decisions log — header-always, no body mutation.
- ~~**`@fastify/multipart` scope.**~~ Resolved in decisions log — route-local.
- ~~**Speech `Content-Length` handling.**~~ Resolved in decisions log — always chunked.
- ~~**STT MIME allowlist.**~~ Resolved in decisions log — delegated to node.

## Artifacts produced

Foundation:

- `src/types/node.ts` — `NodeCapability` extended with `'speech'` + `'transcriptions'`.
- `src/types/capability.ts` — `capabilityString` mapping extended with the two new short-forms; `CapabilityStringSchema` (Zod enum) added so the closed set is validated at every worker-facing boundary.
- `src/types/pricing.ts` — new `SpeechRateCard*` and `TranscriptionsRateCard*` schemas + types (model-keyed, mirror the embeddings shape).
- `src/types/speech.ts` — `SpeechRequestSchema` (Zod) with the OpenAI-compat fields and the 4096-char cap.
- `src/types/transcriptions.ts` — `TranscriptionsFormFieldsSchema`, `TranscriptionsResponseFormatSchema`, plus `TRANSCRIPTIONS_DURATION_HEADER` and `TRANSCRIPTIONS_MAX_FILE_BYTES` constants.
- `src/types/audio.test.ts` — 11 schema-parse tests covering both endpoints.
- `src/config/pricing.ts` — `V1_SPEECH_RATE_CARD` (`tts-1` $18, `tts-1-hd` $36, `kokoro` $6 per 1M chars), `V1_TRANSCRIPTIONS_RATE_CARD` (`whisper-1` $0.0072/min); `rateForSpeechModel` / `rateForTranscriptionsModel` lookup helpers; `PricingConfig` extended.
- `src/service/pricing/index.ts` — `estimateSpeechReservation` + `computeSpeechActualCost` (exact, no drift), `estimateTranscriptionsReservation` (64 kbps worst-case, capped at 60 min) + `computeTranscriptionsActualCost` (per second, ceilinged).
- `src/service/pricing/audio.test.ts` — 12 unit tests covering each helper, rounding behavior, model-not-found errors, and the round-trip estimate=commit invariant for speech.

Migration:

- `migrations/0006_audio_endpoints.sql` — adds `speech` + `transcriptions` to `usage_record_kind`, adds `char_count` + `duration_seconds` columns, rebuilds `usage_record_kind_columns_chk`. The CHECK casts `kind::text` so the freshly-added enum values can be referenced in the same migration transaction (PG 12+ refuses bare enum-literal comparison without that cast).
- `src/repo/schema.ts` — Drizzle schema kept in lock-step.

NodeClient:

- `src/providers/nodeClient.ts` — `SpeechCallInput` / `SpeechCallResult` / `TranscriptionCallInput` / `TranscriptionCallResult` shapes; `NodeClient` interface extended with `createSpeech` + `createTranscription`.
- `src/providers/nodeClient/fetch.ts` — fetch impls. Speech returns the upstream `ReadableStream` for chunk-for-chunk relay and surfaces the upstream `Content-Type`. Transcription forwards a multipart body via Web `ReadableStream`, reads `x-livepeer-audio-duration-seconds` from the response headers as the metering basis, returns `null` when missing/unparseable.

HTTP routes:

- `src/runtime/http/audio/speech.ts` — TTS handler. Reservation = commit (no drift), customer disconnect chains an `AbortController` to the upstream fetch, response is always chunked (no `Content-Length`), Content-Type relayed from the upstream node. Free tier rejected with 402.
- `src/runtime/http/audio/transcriptions.ts` — STT handler. `@fastify/multipart` is registered route-locally inside a fastify scope (other handlers retain their JSON-body parsers). 25 MiB upload cap. Drains the multipart body, validates form fields with Zod, reserves at the worst-case 64 kbps duration, builds an outbound multipart body and forwards via `NodeClient.createTranscription`, commits at the duration the worker reports. Missing duration → 503 + refund.
- `src/main.ts` — wires both routes.

Lint:

- `lint/README.md` + `src/runtime/http/audio/transcriptions.ts` — registered an exemption for `livepeer-bridge/zod-at-boundary` (multipart bodies must be drained before form fields are parseable). The exemption is documented one-liner in the README list.

Docs:

- `docs/references/worker-node-contract.md` — §6 (`speech`) and §7 (`transcriptions`) added; §2 amended to flag the per-section opt-out from the universal `usage` obligation; §10 cross-link added.
- `docs/design-docs/pricing-model.md` — Speech and Transcriptions rate cards documented; margin-math sections extended with per-character and per-second formulas; the audio open item resolved.

Test posture:

- New tests: 23 (12 pricing + 11 schema). All 295 tests in the bridge suite pass under vitest.
- Open follow-up: full integration tests against a fake worker node (mirroring the embeddings/images pattern with TestPg + fake gRPC daemon + fake worker fastify) deferred. Tracked as `audio-endpoints-integration-test` debt entry — the unit + schema coverage validates the contract surface; full-stack tests would catch handler-level orchestration regressions.
