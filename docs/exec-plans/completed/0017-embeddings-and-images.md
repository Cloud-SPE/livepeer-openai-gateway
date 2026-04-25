---
id: 0017
slug: embeddings-and-images
title: /v1/embeddings + /v1/images/generations — synchronous non-chat endpoints
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Add two OpenAI-compatible endpoints in one plan: `/v1/embeddings` and `/v1/images/generations`. They share the important work — a non-chat node capability dimension, a non-token pricing shape, and a non-chat entry in the rate card — so bundling them lands the foundation once and plugs two endpoints on top.

Both endpoints are synchronous JSON request/response. That bounds the plan: no streaming concerns, no proxy path beyond what 0007 already established.

`/v1/audio/speech` is deliberately NOT paired in — it streams raw audio bytes, which is a distinct router/streaming-semantics problem. It ships in its own plan after this one.

Depends on: `0002-types-and-zod`, `0003-customerledger`, `0004-auth-layer`, `0005-nodebook`, `0006-payer-client`, `0007-chat-completions-nonstreaming`, `0011-local-tokenizer-metric`.

## Non-goals

- No `/v1/audio/speech` (TTS). Streaming raw bytes — own plan.
- No `/v1/audio/transcriptions` (STT). Multipart upload in, own plan.
- No batch embeddings (`/v1/batches`). Different async model.
- No image editing (`/v1/images/edits`) or variations (`/v1/images/variations`). Only `/generations`.
- No bridge-side image storage or CDN. Pass the node's response (URL or base64) through.
- No bridge-side embedding cache. Pass-through only.
- No tokenizer-choice-per-model expansion of 0011 beyond what embeddings models need. Image pricing does not use tokens.
- No `/v1/moderations`, `/v1/files`, `/v1/assistants`, `/v1/threads`, or the Responses API. Adjacent OpenAI surface area, out of scope.

## Approach

### Foundation (lands once, serves both endpoints)

- [ ] Extend pricing types (`src/types/pricing.ts`):
  - [ ] `EmbeddingsRateCardEntry` — `{ tier, inputUsdPerMillion }` (input-only, no output column)
  - [ ] `ImagesRateCardEntry` — `{ tier, size, usdPerImage }` keyed by `(tier, size)` so different resolutions carry different rates
  - [ ] Extend `RateCard` to carry optional `embeddings` and `images` sections, or introduce sibling `EmbeddingsRateCard` / `ImagesRateCard` types (decision below)
- [ ] Extend `NodeConfig` (`src/types/node.ts`) with a `capabilities: ('chat' | 'embeddings' | 'images')[]` field. Default to `['chat']` for backwards compatibility so existing `nodes.yaml` entries keep working.
- [ ] `NodeBook.findNodesFor` gains a `capability` dimension. Matcher becomes `capability ∈ node.capabilities && model ∈ node.supportedModels && tier ∈ node.tierAllowed`. Default the new parameter to `'chat'` so 0007's existing caller (`src/runtime/http/chat/...`) compiles and behaves unchanged with no edit.
- [ ] Update `nodes.yaml` example + Zod parser to advertise capabilities. Document the default-`['chat']` migration behavior.
- [ ] Extend rate card (`src/config/pricing.ts`) with embeddings + images entries. Tier mapping for both — see open questions.
- [ ] Migration required: `usage_record.prompt_tokens_reported` and `completion_tokens_reported` are both `NOT NULL` today (`src/repo/schema.ts:103-104`). Images have no token counts and embeddings have no completion tokens — migration must relax these to nullable (or add a discriminator + new columns; see schema decision below). Same for `promptTokensLocal`/`completionTokensLocal` semantics.
- [ ] Extend `UsageMeter` (or equivalent in `service/ledger`) with a non-token path: meter by image count × size for images; meter by input-tokens only for embeddings.
- [ ] Coverage: `npm test` enforces a 75% floor on every v8 metric. Both handlers + foundation add meaningful new surface area; ensure unit tests land alongside each module (handler success, handler error, meter math, migration round-trip, NodeBook capability filter) so the ratchet either holds or moves up — never down.
- [ ] Author `docs/references/worker-node-contract.md` documenting the OpenAI-compatibility obligations per capability (batched embeddings sum, `dimensions`, `encoding_format: base64`, missing-usage handling, image partial-delivery semantics).
- [ ] Update `docs/design-docs/pricing-model.md` with the concrete v1 embeddings + images rate tables (per-model for embeddings; per-(model, size, quality) for images). Lands as a prerequisite doc-PR before code.

### /v1/embeddings

- [ ] Types in `src/types/embeddings.ts`: `EmbeddingsRequestSchema`, `EmbeddingsResponseSchema`. OpenAI shape: `input: string | string[]`, `model`, optional `encoding_format`, `dimensions`, `user`.
- [ ] Handler `src/runtime/http/embeddings/index.ts`
- [ ] Zod parse on body; accept batched `input: string[]`
- [ ] AuthLayer resolve customer (reuse)
- [ ] Token count via `LocalTokenizer` (0011). Sum across array inputs.
- [ ] CustomerLedger: reserve `input_tokens × embeddings_input_rate`
- [ ] Router: NodeBook pick with `capability='embeddings'`
- [ ] PayerDaemon: CreatePayment with input-only budget
- [ ] Extend `NodeClient` with `createEmbeddings`
- [ ] Zod parse node response; validate vector length matches `dimensions` if supplied
- [ ] Commit actual cost from `response.usage.prompt_tokens`
- [ ] Store usage_record (success/partial/failed); `completion_tokens = NULL` or 0
- [ ] Return OpenAI-compatible response
- [ ] Integration test with `openai.embeddings.create` (string and string[] inputs)

### /v1/images/generations

- [ ] Types in `src/types/images.ts`: `ImagesGenerationRequestSchema`, `ImagesResponseSchema`. OpenAI shape: `prompt`, `model`, `n`, `size`, `quality`, `style`, `response_format` (`url` | `b64_json`), `user`.
- [ ] Handler `src/runtime/http/images/generations.ts`
- [ ] Zod parse on body
- [ ] AuthLayer resolve customer
- [ ] Meter pre-flight: `n × usdPerImage(tier, size)`. No tokenizer call.
- [ ] CustomerLedger: reserve `n × per-image-rate` (pricing is deterministic up front for images)
- [ ] Router: NodeBook pick with `capability='images'`
- [ ] PayerDaemon: CreatePayment with image-budget
- [ ] Extend `NodeClient` with `createImage`
- [ ] Zod parse node response
- [ ] Commit actual cost = `response.data.length × per-image-rate` (usually equals reservation; if node returns fewer images, refund the delta)
- [ ] Store usage_record with `image_count = n_returned`, `completion_tokens = NULL`
- [ ] Return OpenAI-compatible response (pass URL or base64 through unchanged)
- [ ] Integration test with `openai.images.generate`

## Decisions log

### 2026-04-24 — Pair embeddings + images in one plan; defer `/v1/audio/speech`

Reason: Embeddings and images are both synchronous JSON request/response, so they share the shape of the router path, the error envelope, and the reserve-then-commit ledger flow. What's new and unshared is small (input-only pricing for embeddings, per-image pricing for images). Bundling them lands the foundation (node capabilities, non-chat rate card, schema migration) once and plugs two endpoints on top. `/v1/audio/speech` is excluded because TTS streams raw audio bytes — that needs a new router proxy path and a streaming-semantics addendum, which is a distinct problem worth its own plan.

### 2026-04-24 — Image partial delivery: commit at actual count, refund the delta

Reason: Matches OpenAI's per-image billing (drop-in compatibility, PRODUCT_SENSE top goal). Mirrors 0007's reserve-then-commit pattern: reserve `n × per-image-rate`, commit `n_returned × per-image-rate`, refund `(n − n_returned) × per-image-rate`. Zero-image returns fall through to the 0007 rule — treat as node contract violation, 503 + full refund. Protects customers from paying for undelivered work without penalizing them for partial success, and keeps ledger semantics consistent across all endpoints.

### 2026-04-24 — Node capability source of truth: file-declared, not node-advertised

Reason: `NodeConfig` is file-driven today (`nodes.yaml`, per 0005). Capabilities live alongside `supportedModels` in the same YAML entry, declared by the operator. The WorkerNode's `/health` response does NOT need to advertise capabilities in v1 — file-authoritative matches the 0005 allowlist model and avoids a reconciliation state machine. Revisit when open node discovery lands (tech-debt-tracker item: "Open node discovery via Livepeer subgraph").

### 2026-04-24 — Embeddings + images rate cards are model-keyed, not tier-keyed

Reason: The three-tier chat rate card works because models within a tier are swappable — the customer says "Standard" and accepts whichever 70B-class model shows up. Embeddings and images break that assumption. `text-embedding-3-small` produces 1536-dim vectors, `-large` produces 3072-dim — the customer must pick a specific model, and the bridge cannot substitute. DALL-E pricing varies by size and quality on the same model. Tier abstraction adds no value here. Shape:

```ts
EmbeddingsRateEntry = { model: ModelId; usdPerMillionTokens: number };
ImagesRateEntry     = { model: ModelId; size: ImageSize; quality: ImageQuality; usdPerImage: number };
```

### 2026-04-24 — Three sibling rate card types, not one extended type

Reason: Today's `RateCard` enforces `entries.length === 3` — softening that to support optional embeddings/images sections weakens chat's invariant and sprays `undefined` checks across call sites. Keep three siblings in `src/config/pricing.ts`: `ChatRateCard` (rename-preserving today's `RateCard` is zero-diff for chat), `EmbeddingsRateCard`, `ImagesRateCard`. Each enforces its own shape and versioning. Callers pick the right one based on the endpoint.

### 2026-04-24 — `usage_record` schema: relax NOT NULL + add `kind` discriminator

Reason: The three-ledger reconciliation query is central to operations (CustomerLedger USD ↔ PayerDaemon EV ↔ TicketBroker on-chain) and queries the single `usage_record` table. Polymorphic tables (`usage_record_{chat,embeddings,images}`) would triple that query and every index; JSON columns lose indexing and weaken Drizzle type safety. Preserve the single table. Migration:

- `ALTER COLUMN prompt_tokens_reported DROP NOT NULL`
- `ALTER COLUMN completion_tokens_reported DROP NOT NULL` (plus the `*_local` twins)
- Add enum `usage_record_kind ('chat', 'embeddings', 'images')`
- Add `kind usage_record_kind NOT NULL DEFAULT 'chat'` (default keeps the migration safe for historical rows)
- Add `image_count integer` (nullable)
- Add `CHECK` constraints enforcing kind→column consistency at the DB level (`kind='chat' ⇒ prompt_tokens_reported IS NOT NULL AND completion_tokens_reported IS NOT NULL`; `kind='embeddings' ⇒ prompt_tokens_reported IS NOT NULL`; `kind='images' ⇒ image_count IS NOT NULL`)

### 2026-04-24 — Node contract is authoritative; bridge enforces via Zod

Reason: Three questions — batched `input[]` embeddings metering, `dimensions` honor, `encoding_format: base64` pass-through — are node-side implementation facts, not bridge decisions. Bridge shouldn't grow per-node compatibility logic or silent post-processing. Instead, spec the contract once and enforce it at the boundary:

- Create `docs/references/worker-node-contract.md` documenting the OpenAI-compatibility obligations for each capability
  - Batched embeddings: node MUST return `usage.prompt_tokens` as the sum across all inputs
  - `dimensions`: node MUST honor end-to-end; bridge does NO post-truncation
  - `encoding_format: base64`: node MUST honor; bridge does NO float→base64 conversion
- Bridge validates responses via Zod parse; contract violations → 503 + refund (reuse 0007's missing-usage decision)
- If a node that does not meet the full contract surfaces later, drop it from the relevant `capability` in `nodes.yaml` rather than add bridge compatibility shims

Keeps the bridge thin and locates OpenAI-compatibility work where it belongs: in the node, which owns response generation.

## Open questions

### Pricing

- ~~**Embeddings tier mapping.**~~ Resolved — model-keyed `EmbeddingsRateEntry { model, usdPerMillionTokens }` (see decisions log).
- ~~**Images tier mapping.**~~ Resolved — model-keyed `ImagesRateEntry { model, size, quality, usdPerImage }` (see decisions log).
- ~~**Rate card type shape.**~~ Resolved — three sibling types `ChatRateCard` / `EmbeddingsRateCard` / `ImagesRateCard` (see decisions log).
- **Concrete v1 rate numbers.** The type shape is locked; the actual USD values for the launch rate cards (per-model embeddings + per-(model,size,quality) images) still need a pricing-model doc update before implementation. Track as a prerequisite PR to `docs/design-docs/pricing-model.md`.

### Metering and ledger

- ~~**Batched `input: string[]` for embeddings.**~~ Resolved — node contract requires `usage.prompt_tokens` as the sum (see decisions log + `docs/references/worker-node-contract.md`).
- ~~**`dimensions` override (embeddings).**~~ Resolved — node honors end-to-end; bridge does no truncation (see decisions log).
- ~~**`encoding_format: base64` (embeddings).**~~ Resolved — node honors; bridge does no conversion (see decisions log).
- ~~**Image count on short returns.**~~ Resolved — see decisions log (commit at actual count, refund delta; zero returns → 503 + full refund).
- ~~**`usage_record` schema.**~~ Resolved — relax NOT NULL + add `kind` discriminator + `image_count` column + CHECK constraints (see decisions log).
- **`NodeClient` surface area.** Adding `createEmbeddings` + `createImage` brings `NodeClient` to five distinct call shapes (`/health`, `/quote`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/images/generations`). The 0007 decision keeps all worker-node HTTP in one provider on purpose. Flag if ergonomics suffer during implementation — if a second file emerges inside `providers/workerNode/`, document why in the decisions log.

### Routing / nodes

- **Capabilities default.** Existing `nodes.yaml` entries have no `capabilities` field. On parse, default to `['chat']` so today's deploys keep working. Document this in the nodes.yaml reference + the migration note in this plan.
- ~~**Node capability advertisement.**~~ Resolved — file-declared, not node-advertised, in v1 (see decisions log).
- **Missing `usage` from node (embeddings).** Reuse the 0007 decision: fail 503 + refund. Document in `docs/references/worker-node-contract.md`.

## Artifacts produced

**Docs**
- `docs/references/worker-node-contract.md` — new per-capability contract (chat / embeddings / images)
- `docs/design-docs/pricing-model.md` — embeddings + images rate tables, per-endpoint margin math

**Types**
- `src/types/pricing.ts` — `ChatRateCard` (renamed), `EmbeddingsRateCard`, `ImagesRateCard`, `ImageSize`, `ImageQuality`
- `src/types/node.ts` — `NodeCapability` enum, `capabilities` field (defaults to `['chat']`)
- `src/types/embeddings.ts` — OpenAI-compatible request/response schemas + `normalizeEmbeddingsInput`
- `src/types/images.ts` — OpenAI-compatible request/response schemas + defaults

**Config**
- `src/config/pricing.ts` — v1 rate cards wired in; `rateForEmbeddingsModel`, `rateForImageSku` helpers
- `src/config/nodes.ts` — capabilities parsed from YAML, default preserved

**Service**
- `src/service/nodes/nodebook.ts` — `findNodesFor(..., capability='chat')`
- `src/service/routing/router.ts` — `pickNode(..., capability='chat')`
- `src/service/pricing/index.ts` — `estimateEmbeddingsReservation`, `computeEmbeddingsActualCost`, `estimateImagesReservation`, `computeImagesActualCost`

**Providers**
- `src/providers/nodeClient.ts` — `createEmbeddings`, `createImage` on `NodeClient`
- `src/providers/nodeClient/fetch.ts` — fetch-based implementations

**Runtime**
- `src/runtime/http/embeddings/index.ts` — `/v1/embeddings` handler
- `src/runtime/http/images/generations.ts` — `/v1/images/generations` handler
- `src/main.ts` — both routes registered

**Repo**
- `src/repo/schema.ts` — `usageRecordKind` enum, nullable `prompt_tokens_reported` / `completion_tokens_reported`, `image_count` column, `usage_record_kind_columns_chk` CHECK constraint
- `migrations/0005_thin_black_crow.sql` — migration

**Tests**
- `src/types/types.test.ts` — embeddings + images schema coverage
- `src/config/nodes.test.ts` — capabilities defaults + rejection
- `src/service/nodes/nodebook.test.ts` — capability filtering
- `src/service/pricing/pricing.test.ts` — embeddings + images pricing math
- `src/repo/repo.test.ts` — chat / embeddings / images inserts + CHECK constraint rejection
- `src/runtime/http/embeddings/embeddings.test.ts` — 8 end-to-end tests through the OpenAI SDK
- `src/runtime/http/images/images.test.ts` — 7 end-to-end tests including partial delivery refund + zero-image 503

**Verification**
- `npm test` → 270/270 passing, 91.62% lines / 80.31% branches / 95.08% functions / 91.62% statements (all above the 75% floor)
