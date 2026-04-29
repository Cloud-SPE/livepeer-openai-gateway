# WorkerNode contract (bridge ↔ node)

> **Purpose.** This document specifies the HTTP contract every WorkerNode must meet to be admitted to the bridge's node pool. It is the source of truth when the bridge validates a node's response; contract violations fail the request with `503 service_unavailable` and refund the customer.
>
> **Scope.** OpenAI-compatible inference endpoints served by the node. The payment-layer contract (TicketParams, PriceInfo, `/quote`) is defined in `docs/references/openai-bridge-architecture.md` and the payments-abstraction doc; this document covers only the inference surface.
>
> **Why the contract is authoritative.** The bridge is a thin router. It does not post-process responses, re-tokenize outputs, truncate vectors, or convert encodings. OpenAI-compatibility is owned by the node. A node that cannot meet a capability's obligations must not advertise that capability in the operator-curated overlay (post-engine-extraction: the service-registry-daemon's static-overlay YAML; pre-stage-3 this was the bridge's local `nodes.yaml`).

---

## 1. Capabilities

A WorkerNode is enrolled in the operator-curated overlay with one or more capabilities (post-engine-extraction: `service-registry-daemon/registry.example.yaml`; pre-stage-3: the bridge's local `nodes.yaml`):

```yaml
- id: node-a
  url: https://…
  capabilities: [chat, embeddings, images]
  supportedModels: [llama-3.1-70b, text-embedding-3-small, dall-e-3]
  …
```

Each capability maps to one OpenAI endpoint and a distinct set of contract obligations:

| Capability   | Endpoint                 | Pricing dimension          | Stream? |
| ------------ | ------------------------ | -------------------------- | ------- |
| `chat`       | `/v1/chat/completions`   | input + output tokens      | yes     |
| `embeddings` | `/v1/embeddings`         | input tokens only          | no      |
| `images`     | `/v1/images/generations` | per-image × size × quality | no      |

If `capabilities` is omitted for a node, the bridge defaults to `['chat']` (backwards-compatibility for overlay entries authored before this contract existed).

## 2. Universal obligations

These apply to every capability.

- **Response shape is OpenAI-compatible.** The bridge parses every successful response with Zod against the OpenAI schema. Extra fields are ignored; missing required fields are a 503.
- **`usage` object is present on success — except where a capability section opts out.** If a response is 2xx but carries no `usage` (or a malformed one), the bridge treats it as a node contract violation → 503 + full refund. See `docs/exec-plans/completed/0007-chat-completions-nonstreaming.md` for the original decision. Exceptions are explicit per-section: `speech` (§6) carries no body usage at all; `transcriptions` (§7) carries duration in a response header instead of a usage block.
- **Error envelope on node-side failure.** Nodes return an OpenAI-shaped error body on non-2xx; the bridge passes the `message` through to the customer with its own error `type`/`code` normalization (see `src/runtime/http/errors.ts`).
- **No silent parameter dropping.** If a node cannot honor a request parameter (e.g., `dimensions`, `response_format`), it MUST error, not return a response with the parameter silently ignored.

## 3. `chat` capability

Documented by 0007 + 0008; summarized here for completeness.

- `response.usage.prompt_tokens` and `completion_tokens` both present and non-negative.
- Streaming (`stream: true`): SSE with OpenAI-compatible `data: {...}` frames, terminated by `data: [DONE]`. The final usage frame (when `stream_options.include_usage: true`) carries the final `usage` object.

## 4. `embeddings` capability

### 4.1 Request shape

The bridge forwards the customer's body with minimal transformation. The node must accept:

- `input: string | string[]` — single string or batch.
- `model: string` — the advertised embedding model.
- Optional: `encoding_format: 'float' | 'base64'`, `dimensions: number`, `user: string`.

### 4.2 Response obligations

- `object: 'list'`, `data: [{ object: 'embedding', index, embedding }]`.
- **Batched input metering (load-bearing):** For `input: string[]`, the node MUST return a single `usage.prompt_tokens` that is the **sum** of tokens across all inputs. Per-input token arrays are not supported by the bridge.
- **`dimensions` honor:** If the customer supplied `dimensions`, every vector in `data[].embedding` MUST have length equal to `dimensions`. The bridge does NOT post-truncate. A vector of the wrong length is a 503.
- **`encoding_format: base64` honor:** If the customer supplied `encoding_format: 'base64'`, every `data[].embedding` MUST be the base64-encoded bytes of the float32 vector. The bridge does NOT convert float → base64 server-side.
- **Missing `usage.prompt_tokens`:** 503 + full refund (reuses 0007's decision).

### 4.3 Failure modes

| Node returns                            | Bridge action                              |
| --------------------------------------- | ------------------------------------------ |
| 2xx with `usage.prompt_tokens` missing  | 503 `service_unavailable` + refund         |
| 2xx with vector length ≠ `dimensions`   | 503 `service_unavailable` + refund         |
| 2xx with `encoding_format` mismatch     | 503 `service_unavailable` + refund         |
| 2xx with `data.length !== input.length` | 503 `service_unavailable` + refund         |
| 4xx / 5xx with error envelope           | Pass through to customer (normalized code) |
| Network / timeout                       | 503 + refund, circuit-break counters tick  |

## 5. `images` capability

### 5.1 Request shape

- `prompt: string` (required), `model: string` (required).
- Optional: `n: number` (default 1), `size: '1024x1024' | '1024x1792' | '1792x1024'`, `quality: 'standard' | 'hd'`, `style: 'vivid' | 'natural'`, `response_format: 'url' | 'b64_json'` (default `url`), `user: string`.

The (`model`, `size`, `quality`) triple determines the bridge's reservation and commit amounts — all three must be honored by the node.

### 5.2 Response obligations

- `created: number` (unix seconds), `data: [{ url?: string, b64_json?: string, revised_prompt?: string }]`.
- **Image count:** `data.length ≤ n`. Partial delivery (`1 ≤ data.length < n`) is allowed and billed at actual count (the bridge refunds `(n - data.length) × per-image-rate`). `data.length === 0` is a node contract violation → 503 + full refund.
- **`response_format` honor:** If `response_format: 'url'`, every entry has `url` set. If `response_format: 'b64_json'`, every entry has `b64_json` set. Mixed is a 503.
- **Size / quality honor:** The generated image's actual size and quality MUST match the request parameters. (The bridge cannot verify raster dimensions without decoding — this is an honor-system obligation that ops monitors via sampling.)
- **No bridge-side hosting.** URLs returned by the node are passed through unchanged. The bridge does not proxy, cache, or rehost.

### 5.3 Failure modes

| Node returns                              | Bridge action                              |
| ----------------------------------------- | ------------------------------------------ |
| 2xx with `data.length === 0`              | 503 `service_unavailable` + full refund    |
| 2xx with `1 ≤ data.length < n`            | 200 with partial data, refund the delta    |
| 2xx with mixed `url` / `b64_json` entries | 503 `service_unavailable` + full refund    |
| 2xx with `response_format` mismatch       | 503 `service_unavailable` + full refund    |
| 4xx / 5xx with error envelope             | Pass through to customer (normalized code) |
| Network / timeout                         | 503 + refund, circuit-break counters tick  |

## 6. `speech` capability (TTS)

### 6.1 Request shape

- `model: string` (required), `input: string` (required, ≤ 4096 chars enforced by the bridge), `voice: string` (required).
- Optional: `response_format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'`, `speed: 0.25..4.0`.

### 6.2 Response obligations

- **Body is the audio bytes** for the requested format. No JSON envelope, no base64 wrapping.
- **`Content-Type` reflects the format.** The bridge proxies the header verbatim. If absent, the bridge defaults the customer-visible response to `audio/mpeg`.
- **No `usage` object expected.** Char count is exact at the bridge boundary (`input.length`), so the upfront reservation is the final charge — no reconciliation. This is the codified exception to §2's universal usage obligation.
- **Streaming.** The node SHOULD start writing bytes as soon as synthesis begins; the bridge pipes them through chunk-for-chunk. The bridge never sets `Content-Length` and the node SHOULD NOT rely on the bridge forwarding any length it sets.
- **Mid-stream cancellation.** When the customer disconnects, the bridge cancels the upstream fetch via `AbortSignal`. The node SHOULD release any held resources (GPU, voice model) on cancellation.

### 6.3 Failure modes

| Node returns                  | Bridge action                              |
| ----------------------------- | ------------------------------------------ |
| 4xx / 5xx with error envelope | Pass through to customer (normalized code) |
| Network / timeout             | 503 + refund, circuit-break counters tick  |
| 2xx with empty body           | Customer sees a 0-byte response            |

The customer is billed for the full `len(input)` even when the node returns a partial stream — synthesis work is not refundable once dispatched.

## 7. `transcriptions` capability (STT)

### 7.1 Request shape

- `multipart/form-data`, ≤ 25 MiB upload (enforced by the bridge).
- Required fields: `model`, `file`.
- Optional fields: `prompt`, `response_format: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt'` (default `json`), `temperature: 0.0..1.0`, `language: ISO-639-1`.

The node is responsible for MIME validation. The bridge does NOT maintain a codec allowlist — wrong-MIME uploads are rejected by the node with `400 invalid_request` and the bridge passes that through.

### 7.2 Response obligations

- **Content-Type matches `response_format`.** `application/json` for `json` and `verbose_json`; `text/plain` for `text`; `text/srt` for `srt`; `text/vtt` for `vtt`.
- **`x-livepeer-audio-duration-seconds` response header is REQUIRED on every successful response.** Value is the audio duration in seconds (integer or decimal). This is the single source of truth for billing across every `response_format` — the bridge does NOT parse `verbose_json.duration` as a fallback.
- **No `usage` object required.** Duration in the header replaces the universal usage obligation. This is the codified exception to §2.

### 7.3 Failure modes

| Node returns                                           | Bridge action                              |
| ------------------------------------------------------ | ------------------------------------------ |
| 2xx without `x-livepeer-audio-duration-seconds`        | 503 `service_unavailable` + full refund    |
| 2xx with header that does not parse to `> 0`           | 503 `service_unavailable` + full refund    |
| 4xx / 5xx with error envelope (incl. unsupported MIME) | Pass through to customer (normalized code) |
| Network / timeout                                      | 503 + refund, circuit-break counters tick  |

## 8. Non-compliance

If ops discovers a node that cannot meet the obligations for a capability it has advertised:

1. **First response:** Drop that capability from the node's overlay entry and reload (post-engine-extraction: edit the service-registry-daemon's overlay YAML and recreate the daemon container; pre-stage-3 this was a SIGHUP on the bridge's local `nodes.yaml`). The node keeps serving the capabilities it _can_ meet.
2. **If the node breaks multiple capabilities repeatedly:** Set `enabled: false` and open a ticket with the operator.

The bridge does NOT add per-node compatibility shims. Shims accumulate, drift, and erode the drop-in OpenAI-compatibility promise that customers rely on.

## 9. Versioning

This contract is versioned by the bridge's git tag. Breaking changes (new required fields, removed obligations) land in a new major version and are announced to node operators via the ops channel. Additive changes (new optional fields, new capability) are backwards-compatible and do not require a node update.

## 10. Related docs

- `docs/references/openai-bridge-architecture.md` — bridge architecture, payment layer.
- `docs/design-docs/pricing-model.md` — rate card, margin math.
- `docs/design-docs/retry-policy.md` — router-side retry / circuit-break behavior.
- `docs/exec-plans/completed/0007-chat-completions-nonstreaming.md` — origin of the missing-usage 503+refund rule.
- `docs/exec-plans/completed/0017-embeddings-and-images.md` — plan that introduced the `embeddings` and `images` capabilities.
- `docs/exec-plans/completed/0019-audio-endpoints.md` — plan that introduced the `speech` and `transcriptions` capabilities (this contract's §6, §7).
