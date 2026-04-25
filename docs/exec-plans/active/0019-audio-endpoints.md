---
id: 0019
slug: audio-endpoints
title: /v1/audio/speech + /v1/audio/transcriptions — audio endpoints
status: active
owner: claude
opened: 2026-04-24
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

- [ ] Extend `NodeCapabilitySchema` (`src/types/node.ts`) with `'speech'` and `'transcriptions'`. Existing `['chat']` default preserves backwards compatibility for legacy `nodes.yaml`.
- [ ] Update `nodes.yaml` example to advertise the new capabilities where applicable.
- [ ] Extend pricing types (`src/types/pricing.ts`):
  - `SpeechRateCardEntry` — `{ model, usdPerMillionChars }` (per-character pricing, model-keyed — mirrors the embeddings shape).
  - `TranscriptionsRateCardEntry` — `{ model, usdPerMinute }` (per-minute pricing, model-keyed).
  - Sibling `SpeechRateCard` / `TranscriptionsRateCard` types with `version` + `effectiveAt` + `entries.min(1)`.
- [ ] Extend `src/config/pricing.ts`: add `V1_SPEECH_RATE_CARD` + `V1_TRANSCRIPTIONS_RATE_CARD` entries, and `rateForSpeechModel` / `rateForTranscriptionsModel` lookup helpers. Wire into `PricingConfig`.
- [ ] Extend `src/service/pricing/index.ts`:
  - `estimateSpeechReservation(inputCharCount, model, config)` + `computeSpeechActualCost(charsBilled, model, config)` (char count is deterministic up front, same as embeddings).
  - `estimateTranscriptionsReservation(fileSizeBytes, model, config)` — upper-bound by a worst-case bitrate assumption (e.g. 64 kbps → ~2 min per MB) to avoid under-reserving. `computeTranscriptionsActualCost(durationSeconds, model, config)` commits at the node-reported duration.
- [ ] Extend `src/runtime/http/errors.ts` with any new typed errors (`InvalidAudioUploadError`, etc.) if the generic `ZodError` path isn't enough.
- [ ] Extend `docs/references/worker-node-contract.md`:
  - Amend `§2 Universal obligations` — the "`usage` object is present on success" rule gains an "except where a capability section opts out" clause (speech does).
  - Add `§6 speech` capability section.
  - Add `§7 transcriptions` capability section.
  - Codify the `x-livepeer-audio-duration-seconds` response header obligation for transcriptions across all `response_format` values.
- [ ] Update `docs/design-docs/pricing-model.md` with the v1 speech + transcriptions rate tables, and explicitly document that `/v1/audio/*` (like embeddings + images) is prepaid-tier only in v1.
- [ ] Extend the `capabilityString` helper (from 0020) with `'speech' → 'openai:/v1/audio/speech'` and `'transcriptions' → 'openai:/v1/audio/transcriptions'` entries.
- [ ] Register both routes in `src/main.ts` alongside the existing endpoint registrations.
- [ ] Coverage: `npm test` ≥ 75% floor on all v8 metrics; ratchet up where possible.

### Migration

- [ ] `usage_record` already accommodates non-chat rows via the `kind` enum (0017). Extend the enum with `'speech'` and `'transcriptions'` values. Postgres enums can add values but not remove them; drizzle-kit emits `ALTER TYPE usage_record_kind ADD VALUE 'speech'` (and `'transcriptions'`) as separate statements — verify the generated migration contains both and neither is inside a transaction block that also alters the table (Postgres refuses `ALTER TYPE ... ADD VALUE` inside the same transaction as usage).
- [ ] Add `char_count integer NULL` (speech billing) and `duration_seconds integer NULL` (transcriptions billing) to `usage_record`.
- [ ] Update the `usage_record_kind_columns_chk` CHECK constraint to enforce: `speech ⇒ char_count NOT NULL`, `transcriptions ⇒ duration_seconds NOT NULL`. Existing `chat`/`embeddings`/`images` clauses stay untouched.

### /v1/audio/speech (TTS — streaming bytes out)

- [ ] Types in `src/types/speech.ts`:
  - `SpeechRequestSchema` — `{ model, input: string (max 4096 chars per OpenAI), voice: string, response_format?: 'mp3'|'opus'|'aac'|'flac'|'wav'|'pcm', speed?: 0.25–4.0 }`. Zod enforces the 4096 cap so billing never sees oversized input.
  - No response schema (bytes, not JSON); bridge proxies Content-Type from node.
- [ ] NodeClient extension: `createSpeech(input: SpeechCallInput): Promise<SpeechCallResult>` returning `{ status, stream: ReadableStream<Uint8Array> | null, contentType: string | null, rawErrorBody: string | null }`. Does NOT `.text()`-consume the body on success; hands the stream to the handler. Propagates customer `AbortSignal` to the upstream fetch so cancel mid-stream frees node resources.
- [ ] Handler `src/runtime/http/audio/speech.ts`:
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
- [ ] Integration test via the OpenAI SDK (`openai.audio.speech.create`) + a fake node that emits `audio/mpeg` bytes. Cover: happy path (bytes round-trip), 503 on node 500, free-tier 402, byte-boundary equivalence (hash of input vs. received bytes), mid-stream abort frees the upstream fetch.

### /v1/audio/transcriptions (STT — multipart in, JSON or text out)

- [ ] Register `@fastify/multipart` **scoped to `/v1/audio/transcriptions`** (not global) so other handlers that expect JSON bodies are unaffected. Set `limits.fileSize = 25 * 1024 * 1024` (25 MiB, matches OpenAI cap); over-size upload → 413.
- [ ] Types in `src/types/transcriptions.ts`:
  - `TranscriptionsRequestSchema` — multipart form fields: `model`, `file` (binary), `prompt?`, `response_format?: 'json'|'text'|'srt'|'verbose_json'|'vtt'` (default `'json'`), `temperature?: 0.0–1.0`, `language?: string`.
  - **No single response schema** — response shape is content-type-dependent:
    - `application/json` → parse with `TranscriptionsJsonResponseSchema` (for `json`) or `TranscriptionsVerboseJsonResponseSchema` (for `verbose_json`).
    - `text/plain` / `text/srt` / `text/vtt` → keep body as opaque string; no Zod parse.
- [ ] NodeClient extension: `createTranscription(input: TranscriptionCallInput): Promise<TranscriptionCallResult>`. Returns `{ status, contentType, bodyText, json, reportedDurationSeconds, rawErrorBody }`. Parser logic is **Content-Type-aware**:
  - Read `content-type`. If it starts with `application/json`, `JSON.parse` + Zod-validate against the appropriate response schema.
  - If `text/*`, keep the body as a raw string. `json` field is null.
  - **Duration is always read from the `x-livepeer-audio-duration-seconds` response header** — this is the single source across all `response_format` values. Worker-contract §7 obligates this header on every successful response. If the header is missing or unparseable → bridge returns the raw node response, but the handler fails the commit and refunds (see below).
- [ ] NodeClient sends multipart upload: convert the customer's `@fastify/multipart` Node `Readable` to a Web `ReadableStream` via `Readable.toWeb()` and pipe into the outbound `fetch` body so the file never fully materializes in bridge memory.
- [ ] Handler `src/runtime/http/audio/transcriptions.ts`:
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
- [ ] Integration test via OpenAI SDK (`openai.audio.transcriptions.create`) with a small binary fixture. Cover: happy path with `json`, `verbose_json` with duration header, `text` format (non-JSON body), 503 on missing duration header, 413 on over-size upload, free-tier 402, node-rejected bad MIME → passthrough 400.

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

_(to be populated on completion)_
