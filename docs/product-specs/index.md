# Product specs index

This repo's product is a customer-facing OpenAI-compatible API. Specs here describe behaviors visible to customers and the operator.

## Specs

- [topup-prepaid.md](topup-prepaid.md) — `accepted` — Stripe checkout flow, balance credit, tier upgrade from free

_(planned)_

- `signup-free.md` — free-tier signup, email verification, API key issuance, quota initialization
- `chat-completions.md` — `/v1/chat/completions` request/response, streaming, error shapes, partial-success semantics
- `rate-card.md` — customer-facing pricing per tier (Starter / Standard / Pro), published and versioned
- `quota-and-billing.md` — free-tier monthly quota, prepaid balance debit mechanics, low-balance notifications, refund policy
- `api-keys.md` — issuance, rotation, revocation; rate-limit keying

## Conventions

- Every product-spec has frontmatter: `title`, `status`, `last-reviewed`.
- Specs describe **what the customer experiences**. Implementation goes in `design-docs/`.
- Customer-visible strings (error messages, email templates, invoice copy) should be excerpted here for review, not buried in code.
