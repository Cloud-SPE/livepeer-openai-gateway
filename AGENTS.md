# AGENTS.md — livepeer-openai-gateway

This is an OpenAI-compatible API service that accepts customer requests, routes them to a pool of Livepeer WorkerNodes, and bridges USD billing (prepaid + free tier) to Livepeer's probabilistic-micropayment protocol (via the `livepeer-payment-library` daemon).

**Humans steer. Agents execute. Scaffolding is the artifact.**

## Start here

- Design & domains: [DESIGN.md](DESIGN.md)
- How to plan work: [PLANS.md](PLANS.md)
- Product mental model: [PRODUCT_SENSE.md](PRODUCT_SENSE.md)
- Full architectural reference: [docs/references/openai-bridge-architecture.md](docs/references/openai-bridge-architecture.md)

## Knowledge base layout

- `docs/design-docs/` — catalogued design decisions (`index.md` is the entry)
- `docs/exec-plans/active/` — in-flight work with progress logs
- `docs/exec-plans/completed/` — archived plans; do not modify
- `docs/exec-plans/tech-debt-tracker.md` — known debt, append-only
- `docs/product-specs/` — customer-facing behaviors (signup, top-up, endpoints, portal, admin)
- `docs/generated/` — auto-generated; never hand-edit
- `docs/operations/` — operator guides (deployment, runbooks)
- `docs/references/` — external material (abstraction doc, harness PDF, architecture doc)
- `bridge-ui/` — browser apps (sibling to `src/`, not under it). `bridge-ui/shared/` is a directory module of cross-UI primitives consumed by `bridge-ui/portal/` (customer self-service) and `bridge-ui/admin/` (operator console). npm-workspace root hoists `lit` + `rxjs` into one `node_modules`. See [docs/design-docs/ui-architecture.md](docs/design-docs/ui-architecture.md).

## The layer rule (non-negotiable)

Source under `src/` follows a strict dependency stack:

```
types → config → repo → service → runtime
```

Cross-cutting concerns (PayerDaemon gRPC client, Stripe, Redis, Postgres, tokenizer, chain RPC) enter through a single layer: `src/providers/`. Nothing in `service/` may import `stripe`, `ioredis`, `@grpc/*`, `pg`, `tiktoken` etc. directly — only through a `providers/` interface.

`bridge-ui/` is **not** part of the `src/` layer stack. It is a sibling deliverable that talks to the bridge over HTTP only and may not import from `src/`.

Lints enforce this in CI. See [docs/design-docs/architecture.md](docs/design-docs/architecture.md).

## Toolchain

- Node.js 20+
- TypeScript 5.4+
- ESLint 9 (flat config) with custom rules
- Zod at all HTTP and gRPC boundaries

## Commands

- `npm run build` — compile TypeScript **and** build both UI modules (`bridge-ui/portal/dist`, `bridge-ui/admin/dist`)
- `npm run build:server` — TypeScript server only
- `npm run build:ui` — UI modules only (workspace `npm ci` + `build:all`)
- `npm test` — server vitest + portal vitest + portal Web Test Runner + admin vitest + admin Web Test Runner
- `npm run dev:ui:portal` / `dev:ui:admin` — Vite dev servers (proxy `/v1` and `/admin` to the local bridge port)
- `npm run lint` — ESLint + custom layer-check (server only; `bridge-ui/**` is plain JS, owns its own test infra)
- `npm run typecheck` — `tsc --noEmit`
- `npm run fmt` — Prettier
- `npm run doc-lint` — validate knowledge-base cross-links + frontmatter, and that `bridge-ui/<consumer>/lib/` does not redefine names from `bridge-ui/shared/lib/`

## Invariants (do not break without a design-doc)

1. **Customer never sees wei.** All customer-facing units are USD or tokens. Wei/ETH is internal.
2. **Zod at boundaries.** Every HTTP body and every gRPC response is parsed through a Zod schema before entering `service/`.
3. **Providers boundary.** No cross-cutting dependency is imported outside `src/providers/`.
4. **No code without a plan.** Non-trivial work starts with an entry in `docs/exec-plans/active/`.
5. **Atomic ledger debits.** Every customer debit is under a DB-level lock. No exceptions.
6. **Fail-closed on payment daemon outage.** If PayerDaemon is unreachable, requests return 503. Never proceed without payment.
7. **Test coverage ≥ 75%.** All four v8 metrics (lines, branches, functions, statements) enforced by `npm test`. Do not lower the floor; raise it when possible.

## Where to look for X

| Question                            | Go to                                            |
| ----------------------------------- | ------------------------------------------------ |
| What does the bridge do?            | [DESIGN.md](DESIGN.md)                           |
| Why is X done this way?             | `docs/design-docs/`                              |
| What's in flight?                   | `docs/exec-plans/active/`                        |
| Customer tiers / pricing / quotas?  | `docs/design-docs/tiers.md` + `pricing-model.md` |
| How does streaming work?            | `docs/design-docs/streaming-semantics.md`        |
| Retry policy?                       | `docs/design-docs/retry-policy.md`               |
| How do tokens get audited?          | `docs/design-docs/token-audit.md`                |
| PayerDaemon wire protocol?          | `docs/design-docs/payer-integration.md`          |
| Node lifecycle / circuit breaker?   | `docs/design-docs/node-lifecycle.md`             |
| Stripe top-up + dispute flow?       | `docs/design-docs/stripe-integration.md`         |
| Admin / ops endpoints?              | `docs/product-specs/admin-endpoints.md`          |
| Customer portal UX?                 | `docs/product-specs/customer-portal.md`          |
| Operator console UX?                | `docs/product-specs/operator-admin.md`           |
| How is the UI structured?           | `docs/design-docs/ui-architecture.md`            |
| How to deploy / run the full stack? | `docs/operations/deployment.md`                  |
| Known debt?                         | `docs/exec-plans/tech-debt-tracker.md`           |
