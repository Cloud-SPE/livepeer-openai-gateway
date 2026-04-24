# openai-livepeer-bridge

An OpenAI-compatible API service that fronts a pool of Livepeer WorkerNodes. Customers pay in USD (prepaid balance + free tier); the service pays nodes via the `livepeer-payment-library` daemon.

> **This is an agent-first repository.** Before making changes, start with [AGENTS.md](AGENTS.md) → [DESIGN.md](DESIGN.md) → [docs/design-docs/](docs/design-docs/).

## What it does

- Accepts OpenAI SDK calls (custom `base_url` + API key we issue)
- `/v1/chat/completions` streaming + non-streaming (v1)
- Free tier (quota-capped) + Prepaid tier (USD balance, Stripe top-ups)
- Routes to a Livepeer WorkerNode; bills the customer in USD; pays the node in ETH via probabilistic micropayments

## Status

Early scaffolding. No functional code yet. See [docs/exec-plans/active/](docs/exec-plans/active/) for current work.

## License

MIT (TBD at first release).
