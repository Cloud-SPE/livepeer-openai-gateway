---
id: 0016
slug: production-docker-stack
title: Production docker stack with tztcloud/payment-daemon:v0.8.10
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Wire the published `tztcloud/payment-daemon:v0.8.10` image into the bridge's compose file as a real, default-on sidecar, and layer a `compose.prod.yaml` override for production-shaped defaults (restart policies, resource limits, log rotation, security hardening, migration-as-a-job, parameterised bridge image).

Supersedes the commented-out `payer-daemon` service block in `compose.yaml` that 0013 deliberately left as a placeholder.

Depends on: 0006 (payer client), 0013 (deployment bootstrap).

## Non-goals

- No Kubernetes / Helm manifests.
- No CI build-and-push of the bridge image (blocked on registry choice — separate tech-debt).
- No multi-arch image publishing.
- No live end-to-end smoke against a real Arbitrum RPC — we have no testnet keystore or RPC creds in this environment. The stack is wired; proving it runs against a real chain is operator-side.
- No TLS termination / ingress fronting. Assumed handled by an external reverse proxy in prod.

## Approach

1. **Reconcile the socket path to the library's convention.** Upstream's image bakes `/var/run/livepeer/payment.sock` as its default socket; the bridge defaults to `/var/run/livepeer-payment-daemon.sock` (code) and `/run/payer-daemon/daemon.sock` (compose). Flip everything to `/var/run/livepeer/payment.sock` and rename the shared volume `payer-socket` → `payment-socket` to match the library's example compose.

2. **Dev stack (`compose.yaml`).** Uncomment the `payment-daemon` service block and pin it to `tztcloud/payment-daemon:v0.8.10`. Sender-mode flags (no `--store-path`, no redemption knobs). Requires `CHAIN_RPC` + keystore files bind-mounted from host. The daemon is a `depends_on` of the bridge with a `service_started` condition (the daemon has no HTTP healthcheck; service-start is the closest signal).

3. **Prod override (`compose.prod.yaml`).** Layer-in:
   - `restart: unless-stopped` on every service.
   - Resource limits (`deploy.resources.limits` cpu/memory) — rough defaults based on a single-replica soft-launch.
   - JSON log driver with size/file rotation (`json-file` with `max-size` / `max-file`).
   - `read_only: true` + `security_opt: [no-new-privileges:true]` on the daemon (mirrors the library's example).
   - `bridge-migrate` one-shot service running `node dist/scripts/migrate.js` (compiled from `scripts/migrate.ts`). Bridge gates on `service_completed_successfully`.
   - `BRIDGE_AUTO_MIGRATE=false` in prod; the one-shot job replaces on-boot migration.
   - `BRIDGE_IMAGE` env param on the bridge service (`image: ${BRIDGE_IMAGE:?set BRIDGE_IMAGE}`), defaulting (in dev) to local `build:`.

4. **`src/scripts/migrate.ts` → compiled output.** `scripts/migrate.ts` currently runs via `node --experimental-strip-types`, which isn't available inside the distroless runtime. Move it under `src/scripts/` so the main `tsc` build compiles it to `dist/scripts/migrate.js` (already shipped by the existing `COPY --from=build /app/dist` in the Dockerfile). The local `db:migrate` script stays on `--experimental-strip-types` against the TS source; compose's prod `bridge-migrate` service runs `node dist/scripts/migrate.js`. Coverage excludes `src/scripts/**` (it's an entrypoint, not library code).

5. **Env knobs.** Add to `.env.example`:
   - `CHAIN_RPC` (required by daemon; Arbitrum One endpoint unless operator is on another chain)
   - `PAYER_KEYSTORE_PATH` (default `./keystore.json`)
   - `PAYER_KEYSTORE_PASSWORD_PATH` (default `./keystore-password`)
   - `PAYER_ORCH_ADDRESS` (optional; commented — hot/cold split)
   - Chain-override block (commented: `EXPECTED_CHAIN_ID`, `TICKETBROKER_ADDRESS`, `ROUNDS_MANAGER_ADDRESS`, `BONDING_MANAGER_ADDRESS`)
   - `BRIDGE_IMAGE` (commented; only needed for the prod override)
   - Flip `PAYER_DAEMON_SOCKET` default to `/var/run/livepeer/payment.sock`.

6. **Operator doc.** New `docs/operations/deployment.md` with:
   - Prereqs (docker, V3 keystore, chain RPC endpoint)
   - Dev walkthrough (`docker compose up --build`)
   - Prod walkthrough (`docker compose -f compose.yaml -f compose.prod.yaml up -d`)
   - Keystore generation pointer (references the library's `running-with-docker.md`)
   - Troubleshooting (socket permission, keystore decrypt, chain-id mismatch — same failure modes the library documents)
   - Notes: multi-replica migration, image publishing, Arbitrum-vs-other-chain.

7. **AGENTS.md + README.md.** Add `docs/operations/` to the knowledge-base layout section and a short "Deploy" section in the README linking to the new doc.

8. **Close tech-debt.** Strike the "Payer-daemon Docker image" entry with a 2026-04-24-in-0016 pointer.

## Decisions log

### 2026-04-24 — Adopt the library's socket path (`/var/run/livepeer/payment.sock`), not the bridge's

Reason: The daemon's image bakes `/var/run/livepeer/payment.sock` as its default; the library's own example compose uses a `payment-socket` named volume. Keeping the bridge's older `/run/payer-daemon/daemon.sock` convention would force every deployment to override the daemon's default flag and rename volumes. Cheaper to conform to upstream; the bridge config is still env-overridable for anyone who wants to move it.

### 2026-04-24 — Ship two compose files (base + prod override), not one unified file with profiles

Reason: Compose profiles can toggle services on/off but can't re-shape a service's `restart`, `deploy`, `logging`, or `security_opt` keys — the prod concerns are all field-level, not service-presence. Two files (`compose.yaml` for dev, `compose.prod.yaml` layered with `-f compose.yaml -f compose.prod.yaml`) is the idiomatic solution. Dev invocation stays one-file (`docker compose up`); prod is the longer command.

### 2026-04-24 — Migrations run as a one-shot job in prod, `BRIDGE_AUTO_MIGRATE=true` in dev

Reason: Single-replica dev doesn't benefit from splitting migration from boot; `true` keeps the `docker compose up` experience self-contained. In prod with any replica-count > 1, on-boot auto-migrate creates the Drizzle migration race documented in tech-debt. A separate service that runs once and exits (`restart: "no"`), gated by `depends_on: { condition: service_completed_successfully }`, is the portable shape. The prod override flips `BRIDGE_AUTO_MIGRATE=false` so nothing re-races if a replica restarts.

### 2026-04-24 — Move `scripts/migrate.ts` into `src/scripts/migrate.ts` instead of adding a second tsconfig

Reason: The distroless runtime has no Node TypeScript loader (`--experimental-strip-types` needs a ts-blessed Node build, which distroless `nodejs20-debian12` does not carry). Three paths to a compiled migrate entrypoint were considered: (a) a second `tsconfig.scripts.json` with its own `outDir`, (b) keeping `scripts/` at the repo root but adding it to the main tsconfig's include, (c) moving the file under `src/scripts/`. Option (a) fragments the build; option (b) makes the main tsconfig's `rootDir` lie. Option (c) is the smallest change — `src/scripts/migrate.ts` compiles to `dist/scripts/migrate.js` through the existing `tsc -p tsconfig.json` invocation, and the existing `COPY --from=build /app/dist` in the Dockerfile already ships it. The layer-check lint treats `src/scripts/` as an unlayered directory (the classifier only recognises `types|config|repo|service|runtime|ui|providers`), so imports aren't policed there — matching the fact that migrate.js composes the full stack, same as `main.ts`.

### 2026-04-24 — Bridge image is parameterised in prod (`BRIDGE_IMAGE`), built inline in dev

Reason: Dev wants `docker compose up --build` to rebuild after local code changes; prod wants to pin a tagged, pushed image. The override replaces the dev service's `build:` with `image: ${BRIDGE_IMAGE}`. Registry decision is still deferred (tracked in tech-debt); the var just says "bring your own tag."

### 2026-04-24 — Daemon runs read-only + no-new-privileges in prod, hardened loosely in dev

Reason: The library's own example compose runs the daemon read-only with `no-new-privileges`. Mirroring that hardening in prod is free (the daemon image is designed for it). Dev leaves read-only off so operator changes to mounted files (e.g., tweaking keystore) don't require recreating the container.

### 2026-04-24 — Depends-on uses `service_started`, not `service_healthy`, for the daemon

Reason: `tztcloud/payment-daemon:v0.8.10` doesn't expose an HTTP health endpoint, so compose can't synthesise a real healthcheck. The bridge has its own `healthPoller` (see 0006) that handles daemon-not-ready states at runtime. Waiting for `service_started` is good enough as a boot-ordering hint.

### 2026-04-24 — No live smoke test as part of this plan

Reason: An end-to-end smoke against a real Arbitrum endpoint would require a funded V3 keystore, an Alchemy/Infura endpoint, and a running worker node to pair with. Out of scope for a repo-level plan; called out in `deployment.md` troubleshooting so operators know the failure surfaces to expect.

## Open questions

- Should the bridge image also adopt `read_only: true`? Currently it writes nothing but `/tmp` (tokenizer WASM temp); adopting read-only would require a tmpfs mount. Deferred — not blocking, and the bridge's `nonroot` user already limits blast radius.
- Should `bridge-migrate` be `profiles: [migrate]` so it doesn't run on every `up`? Compose's `service_completed_successfully` already short-circuits after first success on subsequent runs, so keeping it unconditional is simpler.

## Risks

- **Socket-path migration.** Any existing deployment using `PAYER_DAEMON_SOCKET=/run/payer-daemon/daemon.sock` keeps working (env overrides code default), but `docker compose up` on the updated `compose.yaml` with an old `.env` that pins the old path will mount the daemon's socket to the wrong place. Called out in deployment.md.
- **UID mismatch between bridge and daemon.** Both distroless bases run as uid 65532 by default (nonroot user), so the socket created by the daemon is readable by the bridge. If either image ever changes its runtime uid, the socket breaks silently. Low probability, but worth a note in the doc.

## Artifacts produced

- `compose.yaml` — default dev stack now includes the `payment-daemon` service pinned to `tztcloud/payment-daemon:v0.8.10` (sender mode, Arbitrum defaults, keystore + password bind-mounted from host). Shared socket volume renamed `payer-socket` → `payment-socket`, mounted at `/var/run/livepeer/` on both bridge and daemon to match the library's convention.
- `compose.prod.yaml` — new override layering restart policies, JSON log rotation, resource limits, `read_only: true` + `no-new-privileges:true` on the daemon, parameterised `${BRIDGE_IMAGE}`, and a one-shot `bridge-migrate` service that runs `node dist/scripts/migrate.js` and gates the bridge via `service_completed_successfully`. Prod sets `BRIDGE_AUTO_MIGRATE=false`.
- `src/scripts/migrate.ts` — moved from `scripts/migrate.ts` so the main tsc build emits `dist/scripts/migrate.js` for the prod migration job. `package.json` `db:migrate` updated to the new path; `vitest.config.ts` excludes `src/scripts/**` from coverage (entrypoint, not library code).
- `src/config/payerDaemon.ts` — default socket path flipped to `/var/run/livepeer/payment.sock` (matches the library's baked-in default). Test updated.
- `.env.example` — adds `CHAIN_RPC`, `PAYER_KEYSTORE_PATH`, `PAYER_KEYSTORE_PASSWORD_PATH`, commented `PAYER_ORCH_ADDRESS` for hot/cold split, commented chain-override block, commented `BRIDGE_IMAGE`. Flips `PAYER_DAEMON_SOCKET` default.
- `docs/operations/deployment.md` — new operator guide: dev walkthrough, prod walkthrough, multi-replica notes, troubleshooting (keystore decrypt, chain-id mismatch, socket perms, postgres volume staleness, migration job failures), what's-not-yet-automated list.
- `docs/design-docs/payer-integration.md` — transport line updated to the new socket path; notes it matches the `tztcloud/payment-daemon` image default.
- `AGENTS.md` — adds `docs/operations/` to the knowledge-base layout; new row in the "Where to look for X" table.
- `README.md` — plan index extended to 0016; `docs/` map mentions `operations/`; Run-locally section rewritten for the full-stack default; links to the new deployment guide.
- Tech-debt closed:
  - `Payer-daemon Docker image` (struck through with pointer to 0016).
