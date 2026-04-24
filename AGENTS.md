# AGENTS.md — openai-livepeer-bridge

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
- `docs/product-specs/` — customer-facing behaviors (signup, top-up, endpoints)
- `docs/generated/` — auto-generated; never hand-edit
- `docs/references/` — external material (abstraction doc, harness PDF, architecture doc)

## The layer rule (non-negotiable)

Source under `src/` follows a strict dependency stack:

```
types → config → repo → service → runtime → ui
```

Cross-cutting concerns (PayerDaemon gRPC client, Stripe, Redis, Postgres, tokenizer, chain RPC) enter through a single layer: `src/providers/`. Nothing in `service/` may import `stripe`, `ioredis`, `@grpc/*`, `pg`, `tiktoken` etc. directly — only through a `providers/` interface.

Lints enforce this in CI. See [docs/design-docs/architecture.md](docs/design-docs/architecture.md).

## Toolchain

- Node.js 20+
- TypeScript 5.4+
- ESLint 9 (flat config) with custom rules
- Zod at all HTTP and gRPC boundaries

## Commands

- `npm run build` — compile TypeScript
- `npm test` — run unit tests
- `npm run lint` — ESLint + custom layer-check
- `npm run typecheck` — `tsc --noEmit`
- `npm run fmt` — Prettier
- `npm run doc-lint` — validate knowledge-base cross-links and freshness

## Invariants (do not break without a design-doc)

1. **Customer never sees wei.** All customer-facing units are USD or tokens. Wei/ETH is internal.
2. **Zod at boundaries.** Every HTTP body and every gRPC response is parsed through a Zod schema before entering `service/`.
3. **Providers boundary.** No cross-cutting dependency is imported outside `src/providers/`.
4. **No code without a plan.** Non-trivial work starts with an entry in `docs/exec-plans/active/`.
5. **Atomic ledger debits.** Every customer debit is under a DB-level lock. No exceptions.
6. **Fail-closed on payment daemon outage.** If PayerDaemon is unreachable, requests return 503. Never proceed without payment.

## Where to look for X

| Question                           | Go to                                               |
| ---------------------------------- | --------------------------------------------------- |
| What does the bridge do?           | [DESIGN.md](DESIGN.md)                              |
| Why is X done this way?            | `docs/design-docs/`                                 |
| What's in flight?                  | `docs/exec-plans/active/`                           |
| Customer tiers / pricing / quotas? | `docs/design-docs/tiers.md` (planned)               |
| How does streaming work?           | `docs/design-docs/streaming-semantics.md` (planned) |
| Retry policy?                      | `docs/design-docs/retry-policy.md` (planned)        |
| How do tokens get audited?         | `docs/design-docs/token-audit.md` (planned)         |
| Known debt?                        | `docs/exec-plans/tech-debt-tracker.md`              |
