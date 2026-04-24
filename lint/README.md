# lint/

Custom lints that enforce architectural invariants beyond what ESLint's built-in rules handle. All six rules are implemented and wired into `npm run lint` via a local ESLint plugin — see `eslint-plugin-livepeer-bridge/`.

## Rules shipped (0014)

| Rule                                      | Severity | Purpose                                                                                                                                                                                                              |
| ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `livepeer-bridge/layer-check`             | error    | Enforce `types → config → repo → service → runtime → ui` + `providers/` reachable from all. Also rejects cross-domain imports inside `service/`.                                                                     |
| `livepeer-bridge/no-cross-cutting-import` | error    | `stripe`, `ioredis`, `pg`, `@grpc/*`, `fastify`, `tiktoken`, `viem`, `pino` may only be value-imported under `src/providers/`. Type-only imports and test files are exempt.                                          |
| `livepeer-bridge/zod-at-boundary`         | error    | `async function handle*` in `src/runtime/http/` must call `.parse()` or `.safeParse()` within the first 5 executable statements.                                                                                     |
| `livepeer-bridge/no-secrets-in-logs`      | error    | Reject identifiers / object keys matching `apiKey`, `adminToken`, `stripeSecret`, `privateKey`, `passphrase`, `keystore`, `pepper`, `bearer`, etc. passed to `console.*` / `logger.*` / `req.log.*` / `reply.log.*`. |
| `livepeer-bridge/file-size`               | warn     | Warn at 400 source lines, error at 600. Excludes `*.test.ts` and `gen/**`.                                                                                                                                           |
| `livepeer-bridge/types-shape`             | error    | Every `src/types/*.ts` (excluding `index.ts` and tests) must export at least one `*Schema` value and at least one `z.infer<typeof X>` / `z.input/z.output<...>` type alias.                                          |

## Exemption patterns

Use `// eslint-disable-next-line livepeer-bridge/<rule>` with a one-line justification above the exempted statement. Current legitimate exemptions:

- `src/runtime/http/chat/streaming.ts:handleStreamingChatCompletion` — body already Zod-parsed by the non-streaming handler that branches into it.
- `src/runtime/http/stripe/webhook.ts:handleWebhook` — validates via `stripe.webhooks.constructEvent` (signature check), which serves the same invariant.

## Plugin skeleton

```
lint/eslint-plugin-livepeer-bridge/
├── index.js          # exports { rules: {...} }
├── package.json      # private workspace package, name: eslint-plugin-livepeer-bridge
└── rules/
    ├── layer-check.js
    ├── no-cross-cutting-import.js
    ├── zod-at-boundary.js
    ├── no-secrets-in-logs.js
    ├── file-size.js
    └── types-shape.js
```

Wired into `eslint.config.js` as:

```js
import livepeerBridge from './lint/eslint-plugin-livepeer-bridge/index.js';
// ...
plugins: { 'livepeer-bridge': livepeerBridge },
rules: { 'livepeer-bridge/layer-check': 'error', /* … */ },
```

## Error message format

Each rule produces a one-line diagnostic with a concrete remediation hint. Agents fixing violations autonomously have enough signal in the message alone — they don't need to read the rule source.

## Not shipped here (tracked in tech-debt)

- **Doc-gardener** (design-doc frontmatter freshness, cross-link integrity) — separate tool; will live under `lint/` as its own subdir when scoped.
- **Proto drift check** (regenerate `src/providers/payerDaemon/gen/` and assert clean diff) — CI job rather than a lint.
- **Full-repo secret scan** (gitleaks-class) — separate tool.
