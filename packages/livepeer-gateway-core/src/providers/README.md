# src/providers/

Cross-cutting concerns live here. This is the **only** layer that may import external libraries for I/O-bearing capabilities (gRPC client, Stripe, Redis, Postgres, tokenizer, chain RPC, metrics, logger).

Every provider is an interface defined in this directory, with one or more implementations as sub-folders:

```
providers/
├── payerDaemon.ts                  # interface
├── payerDaemon/
│   └── grpc/                       # default: @grpc/grpc-js with generated stubs
├── stripe.ts                       # interface
├── stripe/
│   └── sdk/                        # default: stripe SDK
├── redis.ts                        # interface
├── redis/
│   └── ioredis/                    # default: ioredis
├── database.ts                     # interface
├── database/
│   └── pg/                         # default: pg pool
├── tokenizer.ts                    # interface
├── tokenizer/
│   ├── tiktoken/                   # OpenAI-family encodings
│   └── llama/                      # Llama-family (plugin)
├── chainInfo.ts                    # interface
├── chainInfo/
│   └── viem/                       # default: viem read-only client
├── metrics.ts                      # interface
├── metrics/
│   ├── noop/                       # default
│   └── prometheus/                 # optional
└── logger.ts                       # interface
    └── pino/                       # default: pino structured
```

## Rules

- **Only this directory** may import cross-cutting external libraries (`@grpc/*`, `stripe`, `ioredis`, `pg`, `tiktoken`, `viem`, `pino`).
- Interfaces are small and composable. Prefer many narrow interfaces over one wide one.
- Default implementations live under the interface's sub-folder.
- Tests inject fakes/mocks via the same interface.

## Why

`service/*` code depends on these interfaces, not on Stripe, Redis, gRPC, etc. directly. That keeps the business logic testable, swappable, and free of I/O plumbing. It also enforces the architectural boundary mechanically: a lint in CI flags any `service/*` or `repo/*` module that imports a forbidden path.

See `docs/design-docs/architecture.md` and `docs/design-docs/core-beliefs.md` §7.
