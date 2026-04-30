# livepeer-openai-gateway

Cloud-SPE shell over [`@cloudspe/livepeer-openai-gateway-core`](https://github.com/Cloud-SPE/livepeer-openai-gateway-core). Owns:

- USD billing ledger (prepaid balance + free-tier quota) — `service/billing`
- Stripe top-ups + webhook handler — `providers/stripe`, `runtime/http/{billing,stripe}`
- Customer/api-key identity, account dashboard, admin SPA — `service/auth`, `service/admin`, `runtime/http/{account,admin,portal}`
- App-schema migrations (`app.customers`, `app.api_keys`, `app.topups`, `app.reservations`, `app.stripe_webhook_events`, `app.admin_audit_events`)
- Composition root (`main.ts`) wiring engine + shell into one Fastify process

## Deployment

Runs as a single Node process alongside the **payment-daemon** and
**service-registry-daemon** sidecars; see `docs/operations/deployment.md`
in the monorepo root for the compose walkthrough. The shell main.ts
invokes both engine and shell migration runners on startup when
`BRIDGE_AUTO_MIGRATE=true`.

## Status

`0.0.0` — proprietary monorepo workspace member. Built once per release
into the same Docker image that ships engine + shell + frontend.

## License

Proprietary (Cloud SPE).
