---
id: 0018
slug: worker-wire-format-alignment
title: Align bridge wire schemas with the openai-worker-node HTTP contract
status: completed
owner: agent
opened: 2026-04-24
completed: 2026-04-25
---

## Goal

Align the bridge's `nodeClient` schemas and method signatures with the `openai-worker-node` HTTP contract introduced by the worker's 0003 (payment middleware) and 0004–0007 (capability modules) plans. Before this plan, the bridge's `/health` and `/quote` schemas describe the pre-0018 worker shape (camelCase, decimal wei, no `/capabilities` endpoint, no `?sender=&capability=` on `/quote`); after this plan, the bridge can successfully probe a live worker built from the current `openai-worker-node` `main`.

This is phase 1 of the multi-capability bridge rework. It gets the bridge **talking** to the new worker but does not yet reshape `NodeBook`, `router`, or the pricing config. Chat routing continues to work against the one-capability / one-model-per-node `nodes.yaml` allowlist the bridge already uses. Phases 2+ rework data model, routing, and per-capability HTTP routes.

## Non-goals

- **No NodeBook data-model change.** `NodeEntry.quote` stays a single `Quote`; we'll pick one of the worker's per-model prices (the one matching the current model routing) to populate it. Full per-(capability, model) quote storage is phase 2.
- **No router signature change.** `findNodesFor(model, tier, capability)` stays as-is; capability discovery lives in phase 2.
- **No new HTTP routes.** `/v1/embeddings`, `/v1/images/*`, `/v1/audio/*` bridge routes land in 0017-embeddings-and-images and a sibling audio plan; this plan only touches the node-probe side.
- **No removal of `supportedModels` from `nodes.yaml`.** That becomes an optional allowlist in phase 2 once runtime capability discovery is in place.

## Depends on

- `openai-worker-node` commits through `2b5cd2a` (worker HTTP contract stable).
- `livepeer-payment-library` `0018-per-capability-pricing` (landed).
- Bridge plans 0005-nodebook, 0006-payer-client, 0007-chat-completions-nonstreaming.

## Approach

- [x] Update `NodeHealthResponseSchema` in `src/providers/nodeClient.ts` to match the worker's `/health` output: `{ status: 'ok' | 'degraded', protocol_version: number, max_concurrent: number, inflight: number }`. Drop the pre-0018 `models: string[]` field — it never landed in production and the new probe pipeline doesn't need it.
- [x] Add `NodeCapabilitiesResponseSchema` — matches `/capabilities`: `{ protocol_version, capabilities: [{ capability: string, work_unit: string, models: [{ model, price_per_work_unit_wei }] }] }`.
- [x] Update `NodeQuoteResponseSchema` to match `/quote`: snake_case field names (`ticket_params`, `face_value_wei`, etc.) and `0x`-prefixed hex byte fields (bridge's `BigIntStringSchema` converts hex via `BigInt('0x…')`). Nested `expiration_params: { creation_round, creation_round_block_hash }` replaces the pre-0018 `expirationParamsHash`. `model_prices: [{ model, price_per_work_unit_wei }]` replaces the single `priceInfo`.
- [x] Add `getCapabilities(url, timeoutMs)` + `getQuotes(url, sender, timeoutMs)` to the `NodeClient` interface and fetch impl. Update `getQuote` signature to take `(url, sender, capability, timeoutMs)` — the worker rejects the old no-query-params form with `400 invalid_request`.
- [x] New config field `bridgeEthAddress` (eth address format, validated by Zod) so the refresher can supply `?sender=`. Kept in the existing `src/config/` layer alongside other bridge-wide config.
- [x] Update `src/service/nodes/quoteRefresher.ts` to pass the new signature: it already fetches a single quote; wire through `bridgeEthAddress` + the capability string `openai:/v1/chat/completions` (the only routed capability today). When storing the result on `NodeEntry.quote`, pick the first `model_prices[]` entry's price as `priceInfo.pricePerUnitWei`. (Phase-2 per-capability storage delivered in 0020.)
- [x] Vitest tests for:
  - New schema parse paths (valid + invalid for each schema).
  - `getCapabilities` happy path + non-2xx.
  - `getQuotes` happy path.
  - `getQuote` with the new signature.
- [x] Update `worker.example.yaml` / equivalent operator docs to note the `bridgeEthAddress` config key.

## Decisions log

### 2026-04-24 — Wire format: snake_case + 0x-hex at the /quote boundary

The worker emits snake_case JSON (matches proto field conventions) and `0x`-prefixed hex for byte-typed fields (matches what the bridge's Zod schemas can parse cleanly via `BigInt('0x…')`). Updating the bridge to accept that (rather than updating the worker to emit camelCase + decimal wei) keeps the worker's wire format consistent with its internal proto types and touches fewer files. Wire-compat with go-livepeer is already preserved at the `net.Payment` bytes level — not at the /quote HTTP layer — so this is a pure bridge-adaptation cost.

### 2026-04-24 — Single Quote per node for phase 1

The worker's `/quote` returns per-model prices. Storing all of them in `NodeEntry` requires reshaping `NodeBook` to key on (capability, model) — a multi-file refactor with test implications. For phase 1 we store ONE quote per node (first model's price) and accept the over-charge when a request routes to a cheaper model. Phase 2 does the reshape properly. The over-debit policy already in place on both sides absorbs the drift.

### 2026-04-24 — `bridgeEthAddress` in bridge config rather than fetched from PayerDaemon

The payer daemon knows the bridge's sender ETH address via its keystore. Fetching it at startup via an extended `GetDepositInfo` (or new RPC) would be the single-source-of-truth approach. For phase 1 we take the simpler path of a config value — it's one line in operator setup and matches the keystore they already configured. Tracked as tech-debt for a later library RPC extension.

## Open questions

- **Does the bridge need per-node `ethAddress` validation against the worker's advertised recipient?** The worker's `/capabilities` doesn't expose the recipient address; only `/quote` does (via `ticket_params.recipient`). We already have `nodes.yaml.ethAddress` per node and validate it at config-reload time (`detectEthAddressChanges`). Cross-checking against the live quote's recipient would add a belt-and-braces guard — worth a follow-up plan, not in this scope.

## Artifacts produced

- `src/providers/nodeClient.ts` — `NodeHealthResponseSchema`, `NodeQuoteResponseSchema` (snake_case + 0x-hex), `NodeCapabilitiesResponseSchema`, `NodeQuotesResponseSchema`. New `GetQuoteInput` + `GetQuotesInput` shapes; `NodeClient` interface gains `getCapabilities` / `getQuotes`; `getQuote` takes `(url, sender, capability, timeoutMs)`.
- `src/providers/nodeClient/fetch.ts` — fetch implementations for `getCapabilities` / `getQuotes` / new `getQuote` signature, with shared timeout + non-2xx handling.
- `src/config/payerDaemon.ts` — `bridgeEthAddress` config field (validated as 0x-prefixed 40-hex via Zod) plumbed from `BRIDGE_ETH_ADDRESS` env.
- `src/service/nodes/quoteRefresher.ts` — switched to batched `getQuotes({ url, sender: bridgeEthAddress })`; phase-1 path picked first `model_prices[]` entry. (Per-capability fan-out followed in 0020.)
- `src/main.ts` — wires `bridgeEthAddress` into the refresher constructor.
- Test updates: `nodebook.test.ts`, `nodes.test.ts`, `quoteRefresher.test.ts`, `nodeClient.test.ts`, `chat/completions.test.ts`, `chat/streaming.test.ts`, `embeddings/embeddings.test.ts`, `images/images.test.ts`, `payerDaemon.test.ts`.

Followed by `0020-per-capability-nodebook` which reshaped `NodeEntry.quote` → `NodeEntry.quotes: Map<string, Quote>` and migrated all routing handlers.
