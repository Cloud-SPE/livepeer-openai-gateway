---
id: 0030
slug: operator-managed-rate-card
title: Operator-managed rate card — admin-SPA-driven pricing for all 5 capabilities, with pattern rules + glob wildcards
status: active
owner: agent
opened: 2026-04-28
---

## Goal

Move the bridge's rate card from hardcoded engine constants to an operator-managed, DB-backed surface editable through the admin SPA. Cover all five capabilities (chat, embeddings, images, speech, transcriptions). Let operators add new model rows and tier-price changes without an engine release or container restart.

This closes the tech-debt item the engine itself called out at `config/pricing.ts:145-146`:

> "Real model names. Add new entries as workers come online with new models; making this env-driven is tracked as `model-tier-env-config` in the tech-debt tracker."

The implementation skips the env-driven step entirely and goes directly to a DB-backed admin UI — env-vars are the wrong primitive for something operators tweak whenever a worker brings up a new model.

## Non-goals

- **No backwards compatibility.** Engine 0.2.0 removes `V1_RATE_CARD` / `V1_MODEL_TO_TIER` entirely; consumers must inject a `RateCardResolver`. Project hasn't shipped to anyone yet, no migration path to preserve.
- **No tier names beyond `starter` / `standard` / `pro` / `premium`.** Operators edit tier *prices*; tier *names* are fixed in the engine. Backlog as a follow-up plan if operators ever need bespoke tiers.
- **No portal-side pricing page.** Customer-facing pricing transparency is `0031`, separate plan.
- **No worker-cost / margin dashboard.** Worker-cost in USD requires an ETH-price oracle; flagged as `0032`.
- **No per-customer rate-card overrides.** Some customers paying different prices than tier defaults is `0033`.
- **No effective-dating of price changes.** Edits apply instantly to subsequent quotes; in-flight reservations honor their original quote (already the engine's behavior).
- **No multi-currency.** USD only.
- **No version history per row.** Audit log (`app.admin_audit_events`) captures all writes; manual rollback via SQL if needed.

## Scope: capabilities and shapes

| Capability | Pricing model | Resolution key |
|---|---|---|
| chat | tiered: `model → tier → (input/output USD/M tokens)` | `(model)` → `tier` → tier prices |
| embeddings | per-model: `model → USD/M tokens` | `(model)` → entry |
| images | per-SKU: `(model, size, quality) → USD/image` | `(model, size, quality)` → entry |
| speech | per-model: `model → USD/M chars` | `(model)` → entry |
| transcriptions | per-model: `model → USD/minute` | `(model)` → entry |

For chat, the operator-managed surface is **two layers**: the `model → tier` mapping (changes per worker) AND the per-tier prices (changes per pricing-strategy update). For the other four capabilities, the model line itself carries the price — no tier indirection.

## Pattern rules

Operators can define **glob patterns** (`*` and `?`, no regex) instead of exact model names. Resolution order:

1. **Exact match** — `{model: "Qwen3.6-27B", tier: "standard"}` always wins.
2. **Pattern match** — `{pattern: "Qwen3.*", tier: "standard"}` — patterns sorted by `sort_order` (operator-controlled); first hit wins.
3. **Hard fail** — `ModelNotFoundError` (HTTP 404 `model_not_found`). No default-tier fallback — silent mispricing risk too high.

For images, pattern matches the **model** field only; `size` and `quality` stay exact match. Operator wanting "all dall-e at 1024x1024 standard" creates one pattern entry; "all dall-e all sizes" creates N entries.

## Architecture

### Engine 0.2.0 — `RateCardResolver` adapter

Parallel to `Wallet`, `AuthResolver`, etc. Operator-injected.

```ts
// engine: src/interfaces/rateCardResolver.ts
export interface RateCardSnapshot {
  chatRateCard: ChatRateCard;
  embeddingsRateCard: EmbeddingsRateCard;
  imagesRateCard: ImagesRateCard;
  speechRateCard: SpeechRateCard;
  transcriptionsRateCard: TranscriptionsRateCard;
  modelToTierExact: ReadonlyMap<string, PricingTier>;
  modelToTierPatterns: ReadonlyArray<{ pattern: string; tier: PricingTier }>;
  // Pattern overlays for the per-model rate cards too:
  embeddingsPatterns: ReadonlyArray<{ pattern: string; entry: EmbeddingsRateCardEntry }>;
  imagesPatterns: ReadonlyArray<{ pattern: string; size: ImageSize; quality: ImageQuality; entry: ImagesRateCardEntry }>;
  speechPatterns: ReadonlyArray<{ pattern: string; entry: SpeechRateCardEntry }>;
  transcriptionsPatterns: ReadonlyArray<{ pattern: string; entry: TranscriptionsRateCardEntry }>;
}

export interface RateCardResolver {
  /** Hot-path sync getter — returns the current snapshot. Hot-path is per-request. */
  current(): RateCardSnapshot;
}
```

Dispatchers no longer take `PricingConfig` directly — they take a `RateCardResolver`. Pricing-service helpers (`resolveTierForModel`, `estimateReservation`, etc.) all walk the resolver's snapshot, applying glob matching.

The engine ships a `createInMemoryRateCardResolver({...})` test fixture (parallel to `InMemoryWallet`) so tests + the minimal-shell example can wire one up without DB.

`V1_RATE_CARD` / `V1_MODEL_TO_TIER` are **deleted** from `config/pricing.ts`. `loadPricingConfig` is repurposed to load the *non-rate-card* parts of pricing config (`defaultMaxTokensPrepaid`, etc.); rate-card data flows entirely through the resolver.

### Shell — DB-backed RateCardResolver

The shell implements `RateCardResolver` against Postgres:

- **Snapshot loaded at startup** from 6 tables (see schema below)
- **In-memory cache**, refreshed every 60s OR on-demand via `invalidate()`
- **Cache-bust on admin writes** — every POST/PUT/DELETE on `/admin/pricing/*` calls `rateCardService.invalidate()` so the next read sees the change immediately on this instance
- **Multi-replica** — TTL-only convergence for now (60s window). Pub/sub invalidation is out of scope; flagged as future when operators scale horizontally.

### Schema (6 new tables)

```sql
-- Tier prices for chat (the only tiered capability).
CREATE TABLE app.rate_card_chat_tiers (
  tier                    TEXT PRIMARY KEY
    CHECK (tier IN ('starter', 'standard', 'pro', 'premium')),
  input_usd_per_million   NUMERIC(20, 8) NOT NULL CHECK (input_usd_per_million  >= 0),
  output_usd_per_million  NUMERIC(20, 8) NOT NULL CHECK (output_usd_per_million >= 0),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Chat: model → tier (exact OR glob pattern).
CREATE TABLE app.rate_card_chat_models (
  id                  UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  model_or_pattern    TEXT  NOT NULL,
  is_pattern          BOOL  NOT NULL,
  tier                TEXT  NOT NULL
    REFERENCES app.rate_card_chat_tiers(tier),
  sort_order          INT   NOT NULL DEFAULT 100,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_or_pattern, is_pattern)
);
CREATE INDEX rate_card_chat_models_exact_idx
  ON app.rate_card_chat_models (model_or_pattern) WHERE is_pattern = false;
CREATE INDEX rate_card_chat_models_patterns_idx
  ON app.rate_card_chat_models (sort_order) WHERE is_pattern = true;

-- Embeddings: model/pattern → USD/M tokens.
CREATE TABLE app.rate_card_embeddings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_or_pattern         TEXT NOT NULL,
  is_pattern               BOOL NOT NULL,
  usd_per_million_tokens   NUMERIC(20, 8) NOT NULL CHECK (usd_per_million_tokens >= 0),
  sort_order               INT  NOT NULL DEFAULT 100,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_or_pattern, is_pattern)
);

-- Images: (model/pattern, size, quality) → USD/image.
CREATE TABLE app.rate_card_images (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_or_pattern  TEXT NOT NULL,
  is_pattern        BOOL NOT NULL,
  size              TEXT NOT NULL,                -- e.g. "1024x1024"
  quality           TEXT NOT NULL CHECK (quality IN ('standard','hd')),
  usd_per_image     NUMERIC(20, 8) NOT NULL CHECK (usd_per_image >= 0),
  sort_order        INT  NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_or_pattern, is_pattern, size, quality)
);

-- Speech: model/pattern → USD/M chars.
CREATE TABLE app.rate_card_speech (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_or_pattern         TEXT NOT NULL,
  is_pattern               BOOL NOT NULL,
  usd_per_million_chars    NUMERIC(20, 8) NOT NULL CHECK (usd_per_million_chars >= 0),
  sort_order               INT  NOT NULL DEFAULT 100,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_or_pattern, is_pattern)
);

-- Transcriptions: model/pattern → USD/minute.
CREATE TABLE app.rate_card_transcriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_or_pattern  TEXT NOT NULL,
  is_pattern        BOOL NOT NULL,
  usd_per_minute    NUMERIC(20, 8) NOT NULL CHECK (usd_per_minute >= 0),
  sort_order        INT  NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_or_pattern, is_pattern)
);
```

**Seed migration** populates the engine's existing `V1` defaults so a fresh deploy doesn't black-hole every chat request. Migration order: schema → seed → tracker entry. Idempotent (tracker prevents re-seed).

### Admin routes (16 total)

```
# Chat — two surfaces (tier prices, model rows)
GET    /admin/pricing/chat/tiers                list { tiers: [...] }
PUT    /admin/pricing/chat/tiers/:tier          { input_usd_per_million, output_usd_per_million }
GET    /admin/pricing/chat/models               list { entries: [...] }
POST   /admin/pricing/chat/models               { model_or_pattern, is_pattern, tier, sort_order? }
DELETE /admin/pricing/chat/models/:id

# Embeddings
GET    /admin/pricing/embeddings                list
POST   /admin/pricing/embeddings                { model_or_pattern, is_pattern, usd_per_million_tokens, sort_order? }
DELETE /admin/pricing/embeddings/:id

# Images
GET    /admin/pricing/images                    list
POST   /admin/pricing/images                    { model_or_pattern, is_pattern, size, quality, usd_per_image, sort_order? }
DELETE /admin/pricing/images/:id

# Speech
GET    /admin/pricing/speech                    list
POST   /admin/pricing/speech                    { model_or_pattern, is_pattern, usd_per_million_chars, sort_order? }
DELETE /admin/pricing/speech/:id

# Transcriptions
GET    /admin/pricing/transcriptions            list
POST   /admin/pricing/transcriptions            { model_or_pattern, is_pattern, usd_per_minute, sort_order? }
DELETE /admin/pricing/transcriptions/:id
```

All gated by the existing `adminAuthPreHandler`. Audit-log capture happens automatically via the middleware. Zod schemas at every boundary. 409 on duplicate (PG unique violation), 400 on invalid input, 404 on missing id, 200/201 on success.

### Registry-discovered model dropdown

Extension to `/admin/registry/probe`: each `live[]` entry surfaces its capability + per-capability model list. Already in the daemon's response; bridge needs to project it. The SPA's "+ Add" forms read from this and offer exact-model dropdown vs. free-form pattern textbox.

### SPA: new "Rate Card" tab

```
/admin/console/#/rate-card
  ├── Chat (tier prices + model rows + pattern rules)
  ├── Embeddings (model rows + pattern rules)
  ├── Images (model rows + pattern rules — composite key)
  ├── Speech (model rows + pattern rules)
  └── Transcriptions (model rows + pattern rules)
```

Each sub-tab has:
- A **table** listing exact entries first, then patterns (sorted by `sort_order`)
- A **+ Add** button opening a `bridge-dialog` form
- Form fields:
  - **Exact entry**: model dropdown (registry-populated) + tier-or-price field(s)
  - **Pattern entry**: free-form text input + tier-or-price field(s) + sort_order
  - **Live preview**: as the operator types a glob, the SPA shows "this matches: X, Y, Z" (client-side glob match against `/admin/registry/probe` model list)
- **Edit** (pencil icon) opens the same form pre-populated; PATCH-style upsert
- **Delete** (trash icon) confirms via `bridge-confirm-dialog`

Chat sub-tab additionally has a **Tier Prices** section at the top — 4 fixed rows (starter/standard/pro/premium), inline editable.

## Implementation order

1. **Engine 0.2.0** (publish first; bridge bumps after)
   - `src/interfaces/rateCardResolver.ts` — interface
   - `src/service/pricing/rateCardSnapshot.ts` — glob match + resolution helper
   - `src/service/pricing/index.ts` — refactor every fn to take `RateCardResolver` instead of `PricingConfig`
   - `src/dispatch/{chat,streaming,embeddings,images,speech,transcriptions}.ts` — accept resolver
   - `src/config/pricing.ts` — gut V1 constants; keep only non-rate-card env config
   - `examples/rateCards/inMemoryRateCardResolver.ts` — test fixture
   - `examples/minimal-shell/start.ts` — wire fixture
   - Tests: rateCardResolver glob-match tests; existing pricing tests updated to inject fixture
   - CHANGELOG: BREAKING section
   - Bump to `0.2.0`, tag, push, CI publish

2. **Shell schema + seed** (`packages/livepeer-openai-gateway/migrations/`)
   - `0001_rate_card.sql` — 6 tables
   - `0002_seed_rate_card.sql` — V1 defaults

3. **Shell repo + service** (`src/repo/`, `src/service/pricing/`)
   - 6 repo modules with `list`, `findById`, `insert`, `update`, `delete`
   - `RateCardService` implementing engine's `RateCardResolver` interface
   - Read-through cache with `invalidate()` + 60s background refresh
   - Tests against `testPg`

4. **Shell admin routes** (`src/runtime/http/admin/pricing/{chat,embeddings,images,speech,transcriptions}.ts`)
   - 16 routes total; one file per capability + a `routes.ts` aggregator
   - Each writes call `rateCardService.invalidate()` after DB write
   - Tests in `runtime/http/admin/pricing.test.ts`

5. **Shell registry-probe extension**
   - Surface per-capability `models[]` per node in `/admin/registry/probe`
   - Required minimal change to the existing route handler

6. **SPA**
   - `bridge-ui/admin/lib/services/rateCard.service.js` — single rxjs-backed service for all 5 capabilities
   - `bridge-ui/admin/lib/schemas.js` — parser entries for new endpoints
   - `bridge-ui/admin/components/admin-rate-card.js` — top-level page with sub-tab nav
   - `bridge-ui/admin/components/admin-rate-card-{chat,embeddings,images,speech,transcriptions}.js` — sub-tab pages
   - `bridge-ui/admin/lib/glob.js` — client-side glob match (mirrors server impl)
   - `bridge-ui/admin/main.js` — register route `/rate-card`
   - SPA tests: glob.test.js, rateCard.service.test.js

7. **Build + push**
   - Bump shell engine dep to `^0.2.0`
   - `npm run typecheck && npm run lint && npm run test` green; coverage ≥75%
   - `docker build`, smoke (probe + admin/pricing/chat/tiers should return seeded defaults), `docker push tztcloud/livepeer-openai-gateway:v0.8.10`

8. **Verify in prod**
   - Pull bridge image; bridge-migrate runs schema + seed
   - Hit `/admin/pricing/chat/tiers` — confirm seeded V1 defaults
   - In SPA: navigate to `/admin/console/#/rate-card/chat`, add `Qwen3.6-27B → standard`
   - Send `/v1/chat/completions` with `model: "Qwen3.6-27B"` — confirm 200 instead of 404

9. **Archive plan** to `docs/exec-plans/completed/`.

## Risk + rollback

- **Engine 0.2.0 is BREAKING.** Every consumer breaks until they inject a `RateCardResolver`. Acceptable because the only consumer today is this gateway, and we're updating both in lockstep.
- **Open reservations are immune** to rate-card changes. Reservation rows lock the dollar amount at quote time; engine doesn't re-quote on commit. Tested explicitly.
- **Cache TTL window** — rate-card change visible within 60s on multi-replica deploys. Single-replica today, immediate cache-bust on writes makes this invisible.
- **Rollback path** — if the seed migration is wrong, an operator deletes the rows + re-seeds via SQL OR redeploys. Pre-Phase-D images don't read the new tables, so worst-case fallback is downgrading to a v0.8.9 image (none yet, but possible).
- **Glob matching** — implemented from scratch; thoroughly tested against edge cases (`*`, `?`, escaped chars, anchored matches). No regex-injection risk.

## Verification gate

- Engine: 100% test pass; coverage holds; `0.2.0` tag published with sigstore provenance.
- Shell: typecheck/lint clean; coverage ≥75%; `npm test` green.
- SPA: vitest + WTR pass.
- Image: `docker run … migrate.js` reaches DB connect; seeds populate on first boot.
- Prod: `Qwen3.6-27B → standard` added via SPA → chat completion returns 200.

## Done when

- Plan archived to `docs/exec-plans/completed/0030-operator-managed-rate-card.md`
- `@cloudspe/livepeer-openai-gateway-core@0.2.0` published with `RateCardResolver` adapter; CHANGELOG documents the BREAKING surface
- `tztcloud/livepeer-openai-gateway:v0.8.10` rebuilt + pushed; bridge consumes 0.2.0 and serves `/admin/pricing/*`
- Operator can edit pricing entirely from the admin SPA, with audit-log entries for every change
- The 5-capability dispatcher → resolver path is functional end-to-end against a real `/v1/chat/completions` request

## Follow-up plans

- **0031** — Customer-facing pricing page on the portal (read-only)
- **0032** — Operator margin dashboard (worker-cost in USD via ETH oracle)
- **0033** — Per-customer rate-card overrides
- **Backlog (no plan id yet)** — Operator-addable tier names beyond `starter/standard/pro/premium`
