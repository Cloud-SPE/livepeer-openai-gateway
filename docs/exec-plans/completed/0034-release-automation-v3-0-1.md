---
id: 0034
slug: release-automation-v3-0-1
title: Add tag-triggered Docker release automation and align v3.0.1 versioning
status: completed
owner: codex
opened: 2026-04-30
closed: 2026-04-30
depends-on: Docker Hub secrets configured in GitHub Actions
---

## Goal

Make this repo release like the sibling Livepeer repos: a pushed
semver tag re-runs validation, builds the Docker image, and publishes it
to Docker Hub under `tztcloud/livepeer-openai-gateway`.

## Non-goals

- Do not redesign the runtime or deployment topology.
- Do not change upstream package or daemon contracts.
- Do not modify archived exec-plans.

## Approach

- [x] Add a GitHub Actions workflow triggered by `v*.*.*` tags that runs
      format, lint, typecheck, docs, tests, then publishes semver Docker
      tags plus `latest`.
- [x] Bump repo/package versions from `3.0.0` to `3.0.1` so the release
      tag matches package metadata.
- [x] Replace stale local Docker script defaults and operator docs that
      still point at the old rolling `v0.8.10` image tag.
- [x] Validate the updated release path locally as far as this repo can
      without registry credentials.

## Decisions log

### 2026-04-30 — Match the secure-orch-console release pattern

Reason: this repo needs a semver-tag-driven Docker publish flow, and the
closest existing suite precedent is `livepeer-secure-orch-console`.
Using the same overall shape keeps operations consistent across repos.

## Artifacts produced

- `.github/workflows/release.yml`
- `package.json`
- `package-lock.json`
- `packages/livepeer-openai-gateway/package.json`
- `scripts/docker-tag.sh`
- `scripts/docker-push.sh`
- `compose.prod.yaml`
- `README.md`
- `docs/operations/deployment.md`
- `docs/operations/portainer-deploy.md`
- `docs/exec-plans/tech-debt-tracker.md`
