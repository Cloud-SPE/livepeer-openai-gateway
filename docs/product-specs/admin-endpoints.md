---
title: Admin / ops endpoints
status: accepted
last-reviewed: 2026-04-26
---

# Admin endpoints

Operator-only surface for inspecting bridge state and performing manual interventions. Returns JSON; the operator console at `/admin/console/*` is a separate browser app that *consumes* this surface (see [`operator-admin.md`](./operator-admin.md)).

## Authentication

|                  |                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Header           | `X-Admin-Token: <ADMIN_TOKEN>`                                                           |
| Compare          | `timingSafeEqual` on `sha256(token)` bytes                                               |
| IP allowlist     | `ADMIN_IP_ALLOWLIST` env (comma-separated exact IPs; empty = allow all)                  |
| Operator handle  | `X-Admin-Actor: <handle>` — optional, validated `^[a-z0-9._-]{1,64}$`                   |
| Audit trail      | Every request (success or failure) writes a row to `admin_audit_event`                  |

The token is **never** logged in plaintext.

### `X-Admin-Actor` header

The audit `actor` column has historically held the first 16 hex chars of `sha256(token)` — fine for "who did this" when there's one operator, opaque when there are many. The optional `X-Admin-Actor` header replaces that with a human handle (`alice`, `bob.k`) when present and well-formed; otherwise the token-hash fallback applies.

This is **attribution, not authentication.** There is still one shared `ADMIN_TOKEN`; anyone with it can claim any handle. Per-operator tokens + RBAC are Phase 2. The validation regex `^[a-z0-9._-]{1,64}$` is bounded free-text — keeps the column searchable and prevents injection without inviting unbounded growth.

The operator console captures the handle at sign-in and attaches it on every request.

## Endpoints

### `GET /admin/health`

Composed health snapshot.

```json
{
  "ok": true,
  "payerDaemonHealthy": true,
  "dbOk": true,
  "redisOk": true,
  "nodeCount": 3,
  "nodesHealthy": 2
}
```

### `GET /admin/nodes`

List of all NodeBook entries (admission set + broken ones).

```json
{ "nodes": [{ "id": "node-a", "url": "...", "status": "healthy", ... }] }
```

### `GET /admin/nodes/:id`

Single node detail including circuit state and the 20 most-recent `node_health_event` rows.

### `GET /admin/customers/:id`

Full customer snapshot:

- Identity + tier + status + rate-limit policy
- Balance (prepaid) or quota (free)
- Last 20 top-ups (with disputed/refunded flags)
- Last 50 `usage_record` rows

Bigint values are returned as strings (JSON can't carry bigints).

### `POST /admin/customers/:id/refund`

Body (required):

```json
{ "stripeSessionId": "cs_...", "reason": "non-empty human reason" }
```

Effect:

- Looks up the topup by session id.
- If already refunded, returns `{ alreadyRefunded: true }` and no state change.
- Otherwise: sets `topup.refunded_at = now`, flips status to `refunded`, decrements `customer.balance_usd_cents` by the topup amount with `max(0, balance - amount)`.
- Writes an audit row with the reason in the payload.

**Does NOT call Stripe's refund API.** The operator initiates the Stripe refund from the Stripe dashboard; this endpoint is the ledger-side correction.

### `POST /admin/customers/:id/suspend` / `/unsuspend`

Flips `customer.status` between `suspended` and `active`. The auth layer already rejects non-active customers with 401, so suspension is immediately effective on the customer's next request. `closed` status remains an operator-only manual SQL action in v1.

### `GET /admin/escrow`

Bridge-side view of escrow via `PayerDaemon.getDepositInfo`. Returns deposit + reserve in wei as strings. Does **not** call the TicketBroker contract directly — that would need a `ChainInfo` provider, deferred to a later plan.

```json
{ "depositWei": "1000000", "reserveWei": "500000", "withdrawRound": "0", "source": "payer_daemon" }
```

## Search / list endpoints (operator console drill-downs)

Eight cursor-paginated endpoints back the operator console's table views. All accept `limit` (capped per route) and `cursor` (opaque base64url-encoded ISO timestamp). Response includes `next_cursor` (string when more rows are available, `null` when the page is the tail). Pagination order is descending by primary timestamp except for `/admin/reservations` which is ascending (oldest-first — operators investigating stuck reservations want the longest-open at the top).

### `GET /admin/customers?q=&tier=&status=&limit=&cursor=`

Search by `q` (email substring or exact UUID), `tier` (`free|prepaid`), `status` (`active|suspended|closed`). Default `limit` 50, max 200. Returns thin rows; full detail via `GET /admin/customers/:id`.

```json
{
  "customers": [
    { "id": "...", "email": "...", "tier": "prepaid", "status": "active",
      "balance_usd_cents": "1234", "created_at": "..." }
  ],
  "next_cursor": null
}
```

### `GET /admin/customers/:id/api-keys`

List one customer's keys. **Hash never returned.** 404 for unknown customer.

### `POST /admin/customers/:id/api-keys`

Body `{ "label": "<= 64 chars" }` → `{ id, label, key, created_at }`. **`key` returned exactly once** (cleartext); store stores the `sha256_hmac(plaintext, API_KEY_PEPPER)` only. Prefix follows the existing convention (`sk-test-...` / `sk-live-...` per `API_KEY_ENV_PREFIX`).

### `GET /admin/audit?from=&to=&actor=&action=&limit=&cursor=`

Paginated `admin_audit_event` feed. `from`/`to` are ISO timestamps (malformed dates are silently dropped). `actor` is exact match. `action` is substring (ILIKE).

### `GET /admin/reservations?state=open&limit=&cursor=`

Open / committed / refunded reservations, ascending by `created_at`. Each row includes `age_seconds` for direct on-call use (the page on-call hits when `livepeer_bridge_reservation_open_oldest_seconds` alerts).

```json
{ "reservations": [
  { "id": "...", "customer_id": "...", "work_id": "...", "kind": "prepaid",
    "amount_usd_cents": "100", "amount_tokens": null, "state": "open",
    "created_at": "...", "age_seconds": 125 }
], "next_cursor": null }
```

Read-only. A stuck reservation is a symptom; the fix is upstream (PayerDaemon, node health). A "manually close reservation" button would either bypass Invariant 5 (atomic ledger debits) or invent a parallel reconciliation path — neither is in scope.

### `GET /admin/topups?customer_id=&status=&from=&to=&limit=&cursor=`

Cross-customer top-up search for the "customer says they were charged X but it shows Y" support flow. `customer_id` is a UUID; `status` is one of `pending|succeeded|failed|refunded`.

### `GET /admin/nodes/:id/events?limit=&cursor=`

`node_health_event` timeline for one node. Newest first. Powers the circuit-breaker history view on the node detail page.

### `GET /admin/config/nodes`

Read-only view of the loaded `nodes.yaml`:

```json
{
  "path": "/etc/bridge/nodes.yaml",
  "sha256": "<64 hex>",
  "mtime": "...",
  "size_bytes": 512,
  "contents": "<raw yaml>",
  "loaded_nodes": [{ "id": "...", "url": "...", ... }]
}
```

The `sha256` lets operators verify that what's loaded matches what's checked in. Editing `nodes.yaml` from the UI is **out of scope in v1** — operators edit the file and `kubectl apply` / `docker compose up -d`; the QuoteRefresher hot-reloads. 500 with `code: config_unreadable` if the file is missing.

## Audit log

Every admin request (success or failure) writes a row to `admin_audit_event`:

| Column        | Notes                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| `id`          | UUID                                                                                    |
| `actor`       | `X-Admin-Actor` handle when present + valid; otherwise first 16 hex chars of `sha256(ADMIN_TOKEN)`; `"unknown"` for missing/bad-token requests |
| `action`      | `<METHOD> <path>`                                                                       |
| `target_id`   | Route param `:id` when present                                                          |
| `payload`     | JSON-stringified request body (or null)                                                 |
| `status_code` | HTTP response code                                                                      |
| `occurred_at` | timestamp                                                                               |

Retention is indefinite in v1. A scheduled purge is tech-debt.

## Not in v1

- `/admin/reconciliation` (three-ledger summary): requires `ChainInfo` provider + time-series aggregation. Deferred.
- On-chain deposit reads: same reason. `/admin/escrow` surfaces PayerDaemon's view only.
- Prometheus `/admin/metrics` scrape endpoint: waits for the Prometheus sink (tech-debt from 0011).
- Bulk operations (ban, mass-refund): manual one-at-a-time only.
- CIDR support in the IP allowlist.
- Multiple operator identities (all admin traffic shares one token in v1).
