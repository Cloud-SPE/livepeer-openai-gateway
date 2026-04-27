# @cloudspe/livepeer-gateway-core

OSS engine for an OpenAI-compatible gateway over Livepeer WorkerNodes.
Surfaces:

- `@cloudspe/livepeer-gateway-core/runtime/http/{chat,embeddings,images,audio,healthz,metricsHook,errors}` — Fastify route registers + middleware
- `@cloudspe/livepeer-gateway-core/dispatch/*` — protocol-correct dispatchers wrapping NodeClient + Wallet + ServiceRegistry
- `@cloudspe/livepeer-gateway-core/service/{routing,payments,pricing,tokenAudit,rateLimit,metrics}` — engine domains
- `@cloudspe/livepeer-gateway-core/service/admin/{engine,basicAuthResolver}` — operator dashboard backend
- `@cloudspe/livepeer-gateway-core/dashboard` — read-only operator dashboard (HTML, no UI build)
- `@cloudspe/livepeer-gateway-core/providers/*` — DB, HTTP, metrics, Redis, tokenizer, payer-daemon gRPC, service-registry gRPC, NodeClient
- `@cloudspe/livepeer-gateway-core/repo/*` — Drizzle schema (`engine.*` namespace) + repo helpers + migration runner
- `@cloudspe/livepeer-gateway-core/interfaces` — adapter contracts (AuthResolver, AdminAuthResolver, Wallet, RateLimiter, Logger, Caller, NodeClient stubs)
- `@cloudspe/livepeer-gateway-core/types/*` — Zod schemas for OpenAI request/response shapes, capabilities, payment, node, pricing, tier

## Status

`0.1.0-dev` — workspace-internal; consumed by
[`livepeer-openai-gateway`](../livepeer-openai-gateway) only. Stage 4 of
exec-plan 0026 carves this package into its own public Cloud-SPE repo
and publishes 0.1.0 to npm.

## Deployment

Both the **payment-daemon** and the **service-registry-daemon** must be
running as sidecars before the engine starts. The compose file in the
gateway repo wires them up; see `docs/operations/deployment.md` for the
operator walkthrough.

## License

To be set during stage-4 OSS readiness (exec-plan 0028). Apache-2.0
candidate.
