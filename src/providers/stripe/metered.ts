// withMetrics wraps a StripeClient so each outbound API call emits a
// counter+histogram pair through the Recorder. Mirrors the
// service-registry `WithMetrics` pattern.
//
// `op` label values use snake_case forms of the SDK call sites we surface:
//   - `checkout_create`   → checkout.sessions.create
//   - `webhook_construct` → webhooks.constructEvent
//
// `webhooks.constructEvent` is synchronous in the upstream SDK so we measure
// it inline rather than awaiting. The histogram still receives a duration
// (well under one millisecond on the happy path) so signature verification
// regressions are visible. Pass A: dormant; the composition root does not yet
// wrap the concrete client.

import type {
  CheckoutSessionInput,
  CheckoutSessionResult,
  StripeClient,
  StripeEventMinimal,
} from '../stripe.js';
import { OUTCOME_ERROR, OUTCOME_OK, type Recorder } from '../metrics/recorder.js';

const OP_CHECKOUT_CREATE = 'checkout_create';
const OP_WEBHOOK_CONSTRUCT = 'webhook_construct';

export function withMetrics(client: StripeClient, recorder: Recorder): StripeClient {
  return {
    async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
      const start = performance.now();
      try {
        const result = await client.createCheckoutSession(input);
        const durationSec = (performance.now() - start) / 1000;
        recorder.incStripeApiCall(OP_CHECKOUT_CREATE, OUTCOME_OK);
        recorder.observeStripeApiCall(OP_CHECKOUT_CREATE, durationSec);
        return result;
      } catch (err) {
        const durationSec = (performance.now() - start) / 1000;
        recorder.incStripeApiCall(OP_CHECKOUT_CREATE, OUTCOME_ERROR);
        recorder.observeStripeApiCall(OP_CHECKOUT_CREATE, durationSec);
        throw err;
      }
    },

    constructEvent(rawBody: Buffer | string, signature: string): StripeEventMinimal {
      const start = performance.now();
      try {
        const result = client.constructEvent(rawBody, signature);
        const durationSec = (performance.now() - start) / 1000;
        recorder.incStripeApiCall(OP_WEBHOOK_CONSTRUCT, OUTCOME_OK);
        recorder.observeStripeApiCall(OP_WEBHOOK_CONSTRUCT, durationSec);
        return result;
      } catch (err) {
        const durationSec = (performance.now() - start) / 1000;
        recorder.incStripeApiCall(OP_WEBHOOK_CONSTRUCT, OUTCOME_ERROR);
        recorder.observeStripeApiCall(OP_WEBHOOK_CONSTRUCT, durationSec);
        throw err;
      }
    },
  };
}
