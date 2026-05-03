---
id: 0039
slug: admin-node-eligibility-labels
title: Surface node eligibility in admin views
status: completed
owner: codex
opened: 2026-05-03
closed: 2026-05-03
---

## Goal

Make the operator admin surfaces distinguish between nodes that are visible to the bridge and nodes that are actually eligible to receive work, without hiding ineligible nodes from the fleet view.

## Non-goals

- Changing live request routing behavior.
- Changing service-registry-daemon resolver policy or filtering legacy nodes out of its inventory.
- Adding node mutation actions to the admin console.

## Approach

- [x] Add additive eligibility metadata to `/admin/nodes`, `/admin/nodes/:id`, and `/admin/config/nodes`.
- [x] Derive eligibility from the registry client's recognized capability view while preserving existing node health/circuit fields from the admin service.
- [x] Update the admin console schemas and node screens to render eligibility + capability context.
- [x] Update docs and targeted tests to keep the admin contract explicit.

## Decisions log

### 2026-05-03 — Keep visibility and routability separate

Reason: Operators need to see both the full cached fleet and which nodes are actually usable for this gateway. Existing `status` already communicates circuit health; the missing dimension is whether a node advertises any recognized capabilities. The UI/API should expose both instead of overloading one field.

## Open questions

- None.

## Artifacts produced

- `packages/livepeer-openai-gateway/src/runtime/http/admin/routes.ts`
- `packages/livepeer-openai-gateway/src/runtime/http/admin/admin.test.ts`
- `frontend/admin/components/admin-nodes.js`
- `frontend/admin/components/admin-node-detail.js`
- `frontend/admin/components/admin-config.js`
- `frontend/admin/lib/schemas.js`
- `docs/product-specs/admin-endpoints.md`
- `docs/product-specs/operator-admin.md`
