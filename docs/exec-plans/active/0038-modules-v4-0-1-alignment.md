---
id: 0038
slug: modules-v4-0-1-alignment
title: Align daemon image defaults with livepeer-modules-project v4.0.1
status: active
owner: codex
opened: 2026-05-03
---

## Goal

Update the shell repo's operator-facing daemon image pins and deployment docs so they match the current published `livepeer-modules-project` release (`v4.0.1`) for both `payment-daemon` and `service-registry-daemon`.

## Non-goals

- No runtime protocol rewrite work from plan 0032.
- No shell image version bump.
- No edits to completed exec-plans.

## Approach

- [x] Audit all live operator-facing compose and deployment surfaces for stale daemon tags.
- [x] Update compose defaults, `.env.example`, README, and deployment docs to `v4.0.1`.
- [x] Verify the repo still passes the relevant checks and compose renders.

## Decisions log

### 2026-05-03 — Bump daemon image pins independently of the shell release

Reason: The shell image (`tztcloud/livepeer-openai-gateway:3.0.2`) and the modules daemons do not share a version line. The repo should therefore bump only the daemon sidecars to `v4.0.1` while leaving the bridge image references alone.

## Open questions

- Whether a later follow-up should also refresh the older historical release references in completed plans and changelog-style docs. Not required for operator correctness.

## Artifacts produced

- Repo-local updates:
  - `compose.yaml`
  - `compose.prod.yaml`
  - `.env.example`
  - `README.md`
  - `docs/operations/deployment.md`
  - `docs/operations/portainer-deploy.md`
- Verification:
  - `npm run doc-lint`
  - `docker compose -f compose.yaml config` (with placeholder required env vars)
  - `docker compose -f compose.prod.yaml --env-file .env.example config` (with placeholder required env vars)
