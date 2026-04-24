# PRODUCT_SENSE — openai-livepeer-bridge

## What we're building

A drop-in OpenAI-compatible API. A developer points their existing OpenAI SDK at our `base_url` with an API key we issue, and everything works — except the inference runs on decentralized Livepeer WorkerNodes, and we handle the economic bridging (USD in, ETH out to nodes) invisibly.

## Who uses this

### The customer

A developer using the OpenAI SDK (Python, TypeScript, whatever). They care about:

- **It works with my existing code.** No SDK changes. No auth changes beyond the base_url + API key swap.
- **Predictable pricing in USD.** Token rates published up front. No surprise bills.
- **Reliability.** Requests don't fail because the backend is "complicated."
- **Reasonable free tier.** Enough to test a real integration, not a toy demo.

They do **not** care about:

- Ethereum, tickets, escrow, wei, or any blockchain concept.
- Which specific WorkerNode served their request.
- How billing translates from USD to ETH.

If any of these ever leaks into the customer experience, we have failed.

### The operator

Us. We run the bridge. We care about:

- Margin stays positive (node cost in USD < customer charge in USD).
- Free-tier cost is bounded.
- ETH reserve doesn't run out.
- Customer-facing API stays stable through node swaps, price changes, model additions.

## What "good" looks like

- A customer can sign up with email, try the free tier, hit 100K tokens, add $10 USD to their balance, and keep going — all without seeing a single crypto concept.
- The OpenAI SDK works against us unchanged.
- `/v1/chat/completions` streaming feels indistinguishable from OpenAI to the caller.
- Operator can reprice tiers, swap nodes, and top up escrow without touching customer UX.

## Tiers (v1)

| Tier        | Who                                 | Pricing       | Limits                                                                            |
| ----------- | ----------------------------------- | ------------- | --------------------------------------------------------------------------------- |
| **Free**    | Anyone with a verified email        | $0            | 100K tokens/month, 1 model, 1024 max_tokens/request, 1 concurrent, 3 req/min      |
| **Prepaid** | Customers who top up USD via Stripe | Per rate card | Full model access, per-model max_tokens, higher concurrency/rate, hard-stop at $0 |

Enterprise / postpaid tier deferred to v2+.

## Anti-goals

- Not trying to be a general-purpose OpenAI alternative with parity on every endpoint.
- Not a crypto product. Customers never see wei. If onboarding asks about ETH, we have failed.
- Not building a chat UI. This is an API product. Someone else can build chat on top.
- Not a payment processor for third parties. We bridge for our own inference traffic only.
