---
title: Core beliefs
status: accepted
last-reviewed: 2026-04-24
---

# Core beliefs

Non-negotiable invariants. Every design-doc, exec-plan, and line of code in this repo respects these. Changing any of them requires its own design-doc.

## 1. Scaffolding is the artifact

The value we produce is the repository structure, the lints, the CI, the docs, and the exec-plans. Code is generated to fit the scaffold. If a change makes the scaffold weaker, reject it — even if the code is fine.

## 2. Repository knowledge is the system of record

Anything not in-repo doesn't exist. Slack threads, Google Docs, and tribal knowledge are invisible to the agents that maintain this codebase. If a decision matters, it lives in `docs/design-docs/`. If a plan matters, it lives in `docs/exec-plans/`.

## 3. Customer never sees wei

Every customer-facing surface (API responses, errors, dashboards, emails, invoices) denominates in USD and tokens. Ethereum, tickets, and wei are internal implementation details. If a crypto concept ever leaks to a customer, that's a bug.

## 4. Zod at every boundary

Every HTTP request body, HTTP response body, and gRPC response is parsed through a Zod schema before entering `service/`. No raw `JSON.parse` result reaches business logic. This catches node-side malformed responses and client-side malformed requests at the earliest possible point.

## 5. Atomic ledger debits

Every CustomerLedger debit runs under a DB-level lock on the customer row. Never read-modify-write. Concurrent requests from one customer must serialize.

## 6. Fail-closed on PayerDaemon outage

If the local payment daemon is unreachable, requests return 503. Never proceed without payment — even briefly — because in-flight commitments cannot be recovered.

## 7. The providers boundary is the only cross-cutting boundary

`service/*` may not import `stripe`, `ioredis`, `pg`, `@grpc/*`, `tiktoken`, `viem`, or any external cross-cutting dependency directly. Everything external goes through `src/providers/`. Enforced mechanically.

## 8. Enforce invariants, not implementations

Lints check structural properties (layer dependencies, Zod at boundaries, no secrets in logs, file-size limits). They do not prescribe specific libraries, variable names, or stylistic preferences.

## 9. Humans steer; agents execute

Humans author design-docs, open exec-plans, and review outcomes. Agents do the implementation. If an agent is struggling, the fix is almost always to make the environment more legible — not to push harder on the task.

## 10. No code without a plan

Non-trivial changes start with an entry in `docs/exec-plans/active/`. See `PLANS.md`.

## 11. Tests and coverage are non-negotiable

Every production module in `src/` ships with tests. Overall test coverage (lines, branches, functions, statements) is enforced at **≥ 75%** by `vitest`; `npm test` fails below that floor. The threshold ratchets up, never down — if a change lowers the coverage gate, it also needs a design-doc justifying the regression.

## Project-specific invariants

- **Free tier subsidy is capped.** Free tier uses only nodes marked `tier_allowed: [free, prepaid]`. No way for a free-tier request to land on a premium node.
- **Streaming pre-payment is worst-case.** We reserve `max_tokens × customer_rate` and refund the difference at stream end. No post-facto overruns.
- **No retries after any token delivered.** Mid-stream failures result in partial-success responses. Never silently swap nodes after a customer sees output.
- **Tokenizer is metric-only in v1.** Drift is observed, not enforced. Enforcement requires a design-doc change.
