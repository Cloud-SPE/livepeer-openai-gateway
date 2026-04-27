/* eslint-disable @typescript-eslint/no-unused-vars -- the fake StripeClient
   below intentionally accepts every interface method's parameters by name so
   it satisfies the structural type, even when the body ignores them. */
import { describe, expect, it } from 'vitest';
import { withMetrics } from './metered.js';
import { CounterRecorder } from '@cloudspe/livepeer-gateway-core/providers/metrics/testhelpers.js';
import type {
  CheckoutSessionInput,
  CheckoutSessionResult,
  StripeClient,
  StripeEventMinimal,
} from '../stripe.js';

interface FakeOptions {
  failCheckout?: boolean;
  failConstructEvent?: boolean;
}

function fakeClient(opts: FakeOptions = {}): StripeClient {
  return {
    async createCheckoutSession(_input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
      if (opts.failCheckout) throw new Error('stripe down');
      return { sessionId: 'sess_1', url: 'https://stripe.test/sess_1' };
    },
    constructEvent(_rawBody: Buffer | string, _signature: string): StripeEventMinimal {
      if (opts.failConstructEvent) throw new Error('bad signature');
      return { id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } };
    },
  };
}

const checkoutInput: CheckoutSessionInput = {
  customerId: 'cust_1',
  amountUsdCents: 1000,
  successUrl: 'https://example.com/success',
  cancelUrl: 'https://example.com/cancel',
};

describe('stripe withMetrics', () => {
  it('records ok counter+histogram on successful checkout creation', async () => {
    const rec = new CounterRecorder();
    const client = withMetrics(fakeClient(), rec);

    const out = await client.createCheckoutSession(checkoutInput);

    expect(out.sessionId).toBe('sess_1');
    expect(rec.stripeApiCalls).toBe(1);
    expect(rec.stripeApiCallObservations).toBe(1);
  });

  it('records error counter+histogram when checkout creation rejects', async () => {
    const rec = new CounterRecorder();
    const client = withMetrics(fakeClient({ failCheckout: true }), rec);

    await expect(client.createCheckoutSession(checkoutInput)).rejects.toThrow('stripe down');
    expect(rec.stripeApiCalls).toBe(1);
    expect(rec.stripeApiCallObservations).toBe(1);
  });

  it('records ok pair for synchronous webhook construct', () => {
    const rec = new CounterRecorder();
    const client = withMetrics(fakeClient(), rec);

    const ev = client.constructEvent('raw-body', 'sig');

    expect(ev.id).toBe('evt_1');
    expect(rec.stripeApiCalls).toBe(1);
    expect(rec.stripeApiCallObservations).toBe(1);
  });

  it('records error pair when webhook construct throws', () => {
    const rec = new CounterRecorder();
    const client = withMetrics(fakeClient({ failConstructEvent: true }), rec);

    expect(() => client.constructEvent('raw-body', 'bad')).toThrow('bad signature');
    expect(rec.stripeApiCalls).toBe(1);
    expect(rec.stripeApiCallObservations).toBe(1);
  });

  it('uses distinct op labels for the two SDK call sites', async () => {
    const rec = new CounterRecorder();
    const seenOps: string[] = [];
    const original = rec.incStripeApiCall.bind(rec);
    rec.incStripeApiCall = (op: string, outcome: 'ok' | 'error') => {
      seenOps.push(op);
      original(op, outcome);
    };
    const client = withMetrics(fakeClient(), rec);

    await client.createCheckoutSession(checkoutInput);
    client.constructEvent('raw', 'sig');
    expect(seenOps).toEqual(['checkout_create', 'webhook_construct']);
  });
});
