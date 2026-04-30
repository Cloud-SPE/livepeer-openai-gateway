---
id: 0029
slug: admin-customer-onboarding
title: Admin customer onboarding — POST /admin/customers + GET /admin/config/nodes + SPA create form
status: completed
owner: agent
opened: 2026-04-27
closed: 2026-04-27
---

## Goal

Two missing capabilities surfaced when the operator dashboard hit prod for the first time:

1. **No way to create the first customer.** The admin SPA's `customers.service.js` only has `select`, `refund`, `suspend`, `unsuspend`, `listKeys`, `issueKey` — no `create`. The original design assumed customers are seeded by the Stripe webhook, but bootstrap requires an out-of-band path.
2. **Stale `/admin/config/nodes` endpoint.** The SPA expects a config-file viewer (`{ path, sha256, mtime, size_bytes, contents, loaded_nodes[] }`) — a leftover from the retired bridge-side `nodes.yaml`. The engine extraction moved node config to the service-registry-daemon, leaving this 404 for everyone.

This plan closes both gaps with backend routes + a minimal SPA "Create Customer" form, and rebuilds the bridge image so prod operators can self-onboard.

## Non-goals

- No new customer fields beyond what `app.customers` already has. Tier, balance, quota, rate-limit-tier, email — anything else is out of scope.
- No edit-customer flow. List → detail → suspend / unsuspend / refund / issue-key already exists; mutating tier/balance from the SPA is out of scope.
- No re-architecting `/admin/config/nodes` to read the daemon's mounted YAML. Synthetic response is sufficient — the SPA's UI just needs valid JSON to render its config tab.
- No SPA test coverage gate. The frontend workspace doesn't enforce a coverage floor; a manual browser pass is the verification path.
- No migration changes. The schema already supports everything we need.

## Architecture

### Backend (`packages/livepeer-openai-gateway/`)

**`POST /admin/customers`** — calls a new `ShellAdminService.createCustomer(input)`:

```ts
input = {
  email: string,
  tier: 'free' | 'prepaid',
  rate_limit_tier?: string,           // default 'default'
  balance_usd_cents?: bigint,         // prepaid only; 0 if omitted
  quota_monthly_allowance?: bigint,   // free only; null if omitted
}
```

- Validate via zod at the route boundary (`livepeer-bridge/zod-at-boundary`)
- `customersRepo.insertCustomer(...)` — already exists
- Audit-log the creation: `app.admin_audit_events { action: 'customer.created', actor: <x-admin-actor>, target: <customer.id>, payload: {email, tier} }`
- Return the same `CustomerDetail` shape as `GET /admin/customers/:id` (lets the SPA reuse its detail view)
- Errors: 409 on duplicate email (Postgres `unique_violation`); 400 on invalid tier or shape

**`GET /admin/config/nodes`** — synthetic response that satisfies the SPA's expected schema:

```ts
{
  path: '<service-registry-daemon>',     // sentinel; signals "not a real file"
  sha256: '',                            // empty when synthetic
  mtime: <process start time>,
  size_bytes: 0,
  contents: '# Managed by service-registry-daemon. The bridge no longer maintains a local nodes.yaml — edit the daemon\'s config to change the worker pool.\n',
  loaded_nodes: [/* serviceRegistry.listKnown() projection */],
}
```

The SPA renders this as "the config" — the user sees the explainer in `contents` and the live node list in `loaded_nodes`.

Requires the route to receive a `serviceRegistry` reference. We extend the route's `deps` shape rather than reaching into the engine's adminService (which is intentionally cached/start-time-static).

### SPA (`frontend/admin/`)

- **New service method** `customersService.create(input)` → `POST /admin/customers`
- **New component** `admin-customer-create` (Lit, modal-style):
  - Form fields: email, tier radio (free / prepaid), rate-limit-tier text, conditional balance/quota
  - On submit: call `customersService.create(...)`, on success select the new customer + close modal
  - On 409: surface "email already exists" inline
- **Wire into** `admin-customers-list`: a `+ New Customer` button next to the search box
- **Update `schemas.js`**: add a parser entry for `POST /admin/customers` (reuse `customerDetail`)

### Audit log

Reuse the existing `app.admin_audit_events` table — same machinery as suspend/unsuspend/refund. The `action` enum is just text in the DB so no migration needed.

## Implementation order

1. **Diagnose 0-nodes** (parallel; cheap). Surface the `registry: enumerated N known nodes` log line. If the daemon has nodes but bridge sees 0, that's a separate bug; if not, the fix is on the daemon's config side.

2. **Backend** (engine: no change; shell: ~150 LOC + tests):
   - `service/admin/shell.ts` — add `createCustomer` to `ShellAdminService`
   - `runtime/http/admin/routes.ts` — add `POST /admin/customers` and `GET /admin/config/nodes`
   - Wire `serviceRegistry` into the route deps (small main.ts edit)
   - Tests in `runtime/http/admin/admin.test.ts`
   - `npm run typecheck && npm run lint && npm run test` green; coverage ≥75%

3. **SPA** (Lit + rxjs):
   - `lib/services/customers.service.js` — add `create` method
   - `components/admin-customer-create.js` — new Lit component (form modal)
   - `components/admin-customers-list.js` — add the "+ New Customer" button
   - `lib/schemas.js` — register `POST /admin/customers` → `customerDetail`
   - `npm run build:ui` produces dist with new bundle
   - Manual browser pass

4. **Image**:
   - `docker build -t tztcloud/livepeer-openai-gateway:v0.8.10 .`
   - Smoke against a phantom DB (verify it boots + dist is intact)
   - `docker push tztcloud/livepeer-openai-gateway:v0.8.10`

5. **Verify in prod**:
   - Pull + restart bridge service
   - Open `/admin/console/`, click "+ New Customer", fill form, submit
   - Confirm customer appears in list + add an API key
   - Confirm `/admin/config/nodes` no longer 404s

6. **Archive plan** to `docs/exec-plans/completed/`.

## Risk + rollback

- **Image push overwrites the published v0.8.10 digest.** Rollback = re-pull the prior digest from local Docker storage and re-push, or rebuild from `git checkout <prior-sha> -- .` + push.
- **SPA bundle increases.** Modal + form is small (~5 KB after gzip); negligible.
- **Audit-log writes during customer creation** add one extra INSERT per create. Trivial.
- **No schema changes** = no migration to roll forward / back.

## Verification gate

- Coverage gate (75% v8 floor) holds across the test suite
- Lint clean
- Image smoke: `docker run … packages/livepeer-openai-gateway/dist/scripts/migrate.js` reaches DB connect step
- Manual: prod admin SPA shows "+ New Customer" button, form submits, customer appears

## Done when

- Plan archived to `docs/exec-plans/completed/0029-admin-customer-onboarding.md`
- `tztcloud/livepeer-openai-gateway:v0.8.10` re-tagged + pushed with a new digest
- Operator can create a customer + issue an API key entirely through the admin SPA
- `/admin/config/nodes` returns 200 with the synthetic shape
