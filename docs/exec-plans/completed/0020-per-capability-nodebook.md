---
id: 0020
slug: per-capability-nodebook
title: Per-(capability, model) NodeBook quotes — 0018 phase 2
status: completed
owner: agent
opened: 2026-04-24
closed: 2026-04-25
completed: 2026-04-25
---

## Goal

Reshape `NodeBook` so each node stores a quote per `(capability, model)` pair, not a single `Quote`. Unblocks every non-chat endpoint that routes with a capability: embeddings (0017, already landed but routing uses the chat quote under the hood), images (0017, same), speech / transcriptions (0019). Without this reshape, a single-node deployment can advertise multiple capabilities but the bridge only knows how to price one.

This is the phase-2 rework 0018 deferred. 0018 non-goals: _"NodeEntry.quote stays a single Quote… Full per-(capability, model) quote storage is phase 2."_

## Non-goals

- No new routes. 0019 and any future endpoint plans own their own HTTP-surface work.
- No dynamic capability discovery at runtime. The bridge still reads `capabilities` from `nodes.yaml`; the reshape is about **storage**, not discovery. A later plan can swap YAML for a live `/capabilities` probe.
- No pricing-logic changes. The existing `rateFor*` helpers already key on the right dimensions; they just need the right quote passed in.
- No wire-format changes — 0018 already aligned the bridge with the worker's post-0018 `/quote` + `/quotes` + `/capabilities`.

## Depends on

- `0018-worker-wire-format-alignment` — complete. Provides `getQuote({ capability })`, `getQuotes`, `getCapabilities`, and `bridgeEthAddress` config.

## Approach

### Data model

- [x] Replace `NodeEntry.quote: Quote | null` with `NodeEntry.quotes: Map<string, Quote>` keyed by capability string (`"openai:/v1/chat/completions"` etc.). Value is the projected-to-domain `Quote`. Per-model prices live inside `Quote.modelPrices: Map<string, bigint>` (option (a) below).
- [x] Decided in favor of option (a): `Quote` gained `modelPrices`, capability-level `ticketParams` stays shared. `NodeEntry.quotes` is the flat capability map; the model dimension lives one level down.
- [x] `NodeBook.setQuote(nodeId, quote)` deleted in favor of `setCapabilityQuote(nodeId, capability, quote)` and `setAllQuotes(nodeId, quotes)`. No back-compat shim — the only caller is `quoteRefresher`, migrated atomically.
- [x] `NodeBook.findNodesFor(model, tier, capability)` now requires the node to have a quote for the given capability string; otherwise it's filtered out (same as `circuit_broken`).

### Quote refresher

- [x] `quoteRefresher.ts` calls `getQuotes({ url, sender: bridgeEthAddress })` once per tick and projects each entry through `setAllQuotes`.
- [x] Single batched call replaces the per-capability fan-out. `NodeClient.getQuotes` returns `{ quotes: [{ capability, quote }] }`.
- [x] A capability the node advertised but `/quotes` omitted is logged at `warn` and stays absent from the node's `quotes` map; routing then excludes it.
- [x] Back-off and circuit behavior unchanged — per-node.

### Routing (chat, embeddings, images handlers)

- [x] All handlers updated to `node.quotes.get(capabilityString(...))`:
  - `src/runtime/http/chat/completions.ts` → `node.quotes.get(capabilityString('chat'))`
  - `src/runtime/http/chat/streaming.ts` → same
  - `src/runtime/http/embeddings/index.ts` → `node.quotes.get(capabilityString('embeddings'))`
  - `src/runtime/http/images/generations.ts` → `node.quotes.get(capabilityString('images'))`
- [x] `src/types/capability.ts` exports `capabilityString(cap: NodeCapability): string`. 0019 extended the map with `'speech'` and `'transcriptions'`.

### Tests

- [x] `NodeBook` tests for `setCapabilityQuote` + `findNodesFor` quote-presence filter (`nodebook.test.ts`).
- [x] `quoteRefresher` test for the multi-capability happy path + the missing-capability case (`quoteRefresher.test.ts` + `nodes.test.ts`).
- [x] Existing chat / embeddings / images integration tests pass against the new shape (test files updated in the same PR).

### Docs

- [x] Worker-node-contract doc (`docs/references/worker-node-contract.md`) carries the `capabilityString` namespace via `/capabilities` + `/quotes` sections.
- [ ] `docs/design-docs/node-lifecycle.md` rewrite for the per-capability quote model — folded into the broader stale-doc sweep tracked separately, not blocking 0020.

## Decisions log

### 2026-04-24 — Phase 2 carved out of 0018 rather than folded in

0018 scoped itself to phase 1 (wire-format alignment) explicitly. Rolling phase 2 back into 0018 at this point would re-open a landed plan; carving it out as 0020 keeps 0018's decisions immutable and gives phase 2 its own decisions log. 0019 (audio) can't ship without 0020 anyway, so this plan is the dependency front that finally lets multi-capability nodes route correctly.

## Open questions

- **`Quote` shape: flat capability-scoped vs. nested model map.** Option (a): `Quote` gains `modelPrices: Map<string, bigint>` alongside the shared `ticketParams`. Option (b): `NodeEntry.quotes: Map<(cap, model), Quote>` with duplicated `ticketParams` across entries. (a) preserves the worker's actual data model (one set of ticket params per capability, N prices) and halves memory; (b) is flatter but fanned-out. Recommend (a); confirm before implementation.
- **Back-compat shim lifetime.** Should `setQuote(nodeId, quote)` stay as a compatibility shim for 1 release, or be deleted atomically with this plan? Recommend delete atomically — the only caller is internal to this repo and will be updated in the same PR.
- **Failure mode when `/quotes` succeeds but one capability is missing.** A node that _could_ quote chat but not images: should `findNodesFor(…, 'images')` return no candidates (strict) or fall back to a partial response that silently routes chat only? Strict is simpler and the operator-facing metric surfaces the gap; recommend strict.

## Artifacts produced

- `src/types/capability.ts` — `capabilityString(cap)` mapping (`chat`/`embeddings`/`images` → `openai:/v1/...`). Single source of truth across the bridge.
- `src/types/node.ts` — `Quote.modelPrices: Map<string, bigint>` added; `NodeEntry.quote` removed in favor of `NodeEntry.quotes: Map<string, Quote>`.
- `src/service/nodes/nodebook.ts` — `setCapabilityQuote`, `setAllQuotes`, `findNodesFor` now requires a quote-for-capability match.
- `src/service/nodes/quoteRefresher.ts` — single `getQuotes({ url, sender })` per tick; projects results into `setAllQuotes`; logs a warn when an advertised capability is missing from the worker's response.
- `src/runtime/http/chat/completions.ts`, `src/runtime/http/chat/streaming.ts`, `src/runtime/http/embeddings/index.ts`, `src/runtime/http/images/generations.ts` — switched to `node.quotes.get(capabilityString(...))`.
- `src/service/routing/router.ts` + `retry.ts` — propagated capability through retry loop so failover continues to require quote presence.
- Test updates: `nodebook.test.ts`, `nodes.test.ts`, `quoteRefresher.test.ts`, `router.test.ts`, `retry.test.ts`, `chat/completions.test.ts`, `chat/streaming.test.ts`, `embeddings/embeddings.test.ts`, `images/images.test.ts`.

Followed by `0019-audio-endpoints` which extends `capabilityString` with `'speech'` and `'transcriptions'` entries.
