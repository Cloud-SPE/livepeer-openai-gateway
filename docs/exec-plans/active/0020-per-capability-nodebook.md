---
id: 0020
slug: per-capability-nodebook
title: Per-(capability, model) NodeBook quotes — 0018 phase 2
status: active
owner: claude
opened: 2026-04-24
---

## Goal

Reshape `NodeBook` so each node stores a quote per `(capability, model)` pair, not a single `Quote`. Unblocks every non-chat endpoint that routes with a capability: embeddings (0017, already landed but routing uses the chat quote under the hood), images (0017, same), speech / transcriptions (0019). Without this reshape, a single-node deployment can advertise multiple capabilities but the bridge only knows how to price one.

This is the phase-2 rework 0018 deferred. 0018 non-goals: *"NodeEntry.quote stays a single Quote… Full per-(capability, model) quote storage is phase 2."*

## Non-goals

- No new routes. 0019 and any future endpoint plans own their own HTTP-surface work.
- No dynamic capability discovery at runtime. The bridge still reads `capabilities` from `nodes.yaml`; the reshape is about **storage**, not discovery. A later plan can swap YAML for a live `/capabilities` probe.
- No pricing-logic changes. The existing `rateFor*` helpers already key on the right dimensions; they just need the right quote passed in.
- No wire-format changes — 0018 already aligned the bridge with the worker's post-0018 `/quote` + `/quotes` + `/capabilities`.

## Depends on

- `0018-worker-wire-format-alignment` — complete. Provides `getQuote({ capability })`, `getQuotes`, `getCapabilities`, and `bridgeEthAddress` config.

## Approach

### Data model

- [ ] Replace `NodeEntry.quote: Quote | null` with `NodeEntry.quotes: Map<string, Quote>` keyed by capability string (`"openai:/v1/chat/completions"` etc.). Value is the projected-to-domain `Quote` (one per capability — per-model prices inside the capability are tracked in the quote's `modelPrices` if we extend `Quote`, or in a parallel map).
- [ ] Decide the model-dimension: either (a) `Quote` gains a `modelPrices: Map<string, bigint>` field so callers can pick a price per model, or (b) `NodeEntry.quotes` is `Map<string, Map<string, Quote>>` keyed `(capability, model)`. Recommend (a) — keeps the capability-level ticket params shared (they're the same across models on a given capability) and localizes model pricing to a nested map. See open question.
- [ ] `NodeBook.setQuote(nodeId, quote)` → `setCapabilityQuote(nodeId, capability, quote)`. Preserve existing method for back-compat during the transition by having it default to `"openai:/v1/chat/completions"`, then delete once all callers migrate.
- [ ] `NodeBook.findNodesFor(model, tier, capability)` already takes `capability` (0017). No signature change; internally it must now verify the node has a quote for that capability before returning it as a candidate. A node without the relevant quote is treated the same as `circuit_broken` — no match.

### Quote refresher

- [ ] `quoteRefresher.ts` currently hardcodes `capability: 'openai:/v1/chat/completions'`. Change to iterate each node's declared `capabilities` and call `getQuotes({ url, sender })` once per tick, then split the batched response into per-capability `setCapabilityQuote` calls.
- [ ] Use `getQuotes` (batched) over per-capability `getQuote` calls to reduce request volume. `NodeClient` already exposes both; `getQuotes` returns `{ quotes: [{ capability, quote }] }`.
- [ ] If a node advertises a capability in `nodes.yaml` but the worker's `/quotes` response doesn't include it, log + metric + mark the capability as unquoted. The capability stays admittable by YAML but no quote = no routing.
- [ ] Back-off and circuit behavior stay the same — per-node, not per-capability. A node that fails `/quotes` entirely opens its circuit.

### Routing (chat, embeddings, images handlers)

- [ ] Update every handler that calls `node.quote` to instead read `node.quotes.get(capability)`. Concretely:
  - `src/runtime/http/chat/completions.ts` → `node.quotes.get('openai:/v1/chat/completions')`
  - `src/runtime/http/chat/streaming.ts` → same
  - `src/runtime/http/embeddings/index.ts` → `node.quotes.get('openai:/v1/embeddings')`
  - `src/runtime/http/images/generations.ts` → `node.quotes.get('openai:/v1/images/generations')`
- [ ] Add a small helper `capabilityString(cap: NodeCapability): string` that maps `'chat' → 'openai:/v1/chat/completions'`, `'embeddings' → 'openai:/v1/embeddings'`, `'images' → 'openai:/v1/images/generations'`. Single source of truth; 0019 extends it for `'speech'` and `'transcriptions'`.

### Tests

- [ ] `NodeBook` tests for `setCapabilityQuote` / `findNodesFor` quote-presence filtering.
- [ ] `quoteRefresher` test: node with 2 capabilities → both quotes populated after one tick.
- [ ] `quoteRefresher` test: node advertises `images` in YAML but worker's `/quotes` omits it → `findNodesFor(…, 'images')` excludes this node while `findNodesFor(…, 'chat')` still matches it.
- [ ] Regression: existing integration tests continue to pass (chat, embeddings, images end-to-end).

### Docs

- [ ] Update `docs/design-docs/node-lifecycle.md` (if it exists) or `docs/references/openai-bridge-architecture.md` to describe the `(capability, model)` quote storage.
- [ ] Note the `capabilityString` mapping in the worker-node-contract doc so operators understand the namespace.

## Decisions log

### 2026-04-24 — Phase 2 carved out of 0018 rather than folded in

0018 scoped itself to phase 1 (wire-format alignment) explicitly. Rolling phase 2 back into 0018 at this point would re-open a landed plan; carving it out as 0020 keeps 0018's decisions immutable and gives phase 2 its own decisions log. 0019 (audio) can't ship without 0020 anyway, so this plan is the dependency front that finally lets multi-capability nodes route correctly.

## Open questions

- **`Quote` shape: flat capability-scoped vs. nested model map.** Option (a): `Quote` gains `modelPrices: Map<string, bigint>` alongside the shared `ticketParams`. Option (b): `NodeEntry.quotes: Map<(cap, model), Quote>` with duplicated `ticketParams` across entries. (a) preserves the worker's actual data model (one set of ticket params per capability, N prices) and halves memory; (b) is flatter but fanned-out. Recommend (a); confirm before implementation.
- **Back-compat shim lifetime.** Should `setQuote(nodeId, quote)` stay as a compatibility shim for 1 release, or be deleted atomically with this plan? Recommend delete atomically — the only caller is internal to this repo and will be updated in the same PR.
- **Failure mode when `/quotes` succeeds but one capability is missing.** A node that *could* quote chat but not images: should `findNodesFor(…, 'images')` return no candidates (strict) or fall back to a partial response that silently routes chat only? Strict is simpler and the operator-facing metric surfaces the gap; recommend strict.

## Artifacts produced

_(to be populated on completion)_
