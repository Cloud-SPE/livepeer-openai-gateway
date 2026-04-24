---
title: Admin / ops endpoints
status: accepted
last-reviewed: 2026-04-24
---

# Admin endpoints

Operator-only surface for inspecting bridge state and performing manual interventions. Not exposed to customers. Not a UI — returns JSON.

## Authentication

|              |                                                                         |
| ------------ | ----------------------------------------------------------------------- |
| Header       | `X-Admin-Token: <ADMIN_TOKEN>`                                          |
| Compare      | `timingSafeEqual` on `sha256(token)` bytes                              |
| IP allowlist | `ADMIN_IP_ALLOWLIST` env (comma-separated exact IPs; empty = allow all) |
| Audit trail  | Every request (success or failure) writes a row to `admin_audit_event`  |

The token is **never** logged in plaintext. The audit `actor` field is the first 16 hex chars of `sha256(token)`, so a leaked audit log doesn't leak the token.

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

## Audit log

Every admin request (success or failure) writes a row to `admin_audit_event`:

| Column        | Notes                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| `id`          | UUID                                                                                    |
| `actor`       | First 16 hex chars of `sha256(ADMIN_TOKEN)`; `"unknown"` for missing/bad-token requests |
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
