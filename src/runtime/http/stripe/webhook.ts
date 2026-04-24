import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../../repo/db.js';
import * as stripeWebhookEventsRepo from '../../../repo/stripeWebhookEvents.js';
import * as billing from '../../../service/billing/index.js';
import type { StripeClient, StripeEventMinimal } from '../../../providers/stripe.js';

export interface WebhookRouteDeps {
  db: Db;
  stripe: StripeClient;
}

interface FastifyRequestWithRawBody extends FastifyRequest {
  rawBody?: string | Buffer;
}

export function registerStripeWebhookRoute(app: FastifyInstance, deps: WebhookRouteDeps): void {
  app.post('/v1/stripe/webhook', { config: { rawBody: true } }, (req, reply) =>
    handleWebhook(req as FastifyRequestWithRawBody, reply, deps),
  );
}

// Stripe webhook validation is not Zod — it's stripe.webhooks.constructEvent
// verifying the signature against the raw body. Same invariant as Zod-at-
// boundary (wire data parsed before use), different mechanism.
// eslint-disable-next-line livepeer-bridge/zod-at-boundary
async function handleWebhook(
  req: FastifyRequestWithRawBody,
  reply: FastifyReply,
  deps: WebhookRouteDeps,
): Promise<void> {
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    await reply.code(400).send({
      error: {
        code: 'invalid_request_error',
        type: 'MissingSignature',
        message: 'stripe-signature header missing',
      },
    });
    return;
  }
  const raw = req.rawBody;
  if (raw === undefined) {
    await reply.code(500).send({
      error: {
        code: 'internal_error',
        type: 'RawBodyMissing',
        message: 'raw body plugin not engaged for webhook route',
      },
    });
    return;
  }

  let event: StripeEventMinimal;
  try {
    event = deps.stripe.constructEvent(raw, signature);
  } catch {
    await reply.code(400).send({
      error: {
        code: 'invalid_request_error',
        type: 'SignatureVerificationFailed',
        message: 'stripe signature verification failed',
      },
    });
    return;
  }

  const payloadJson = typeof raw === 'string' ? raw : raw.toString('utf8');
  const isNew = await stripeWebhookEventsRepo.insertIfNew(
    deps.db,
    event.id,
    event.type,
    payloadJson,
  );
  if (!isNew) {
    await reply.code(200).send({ status: 'duplicate_ignored' });
    return;
  }

  try {
    await dispatchEvent(deps.db, event);
    await reply.code(200).send({ status: 'ok' });
  } catch (err) {
    await reply.code(500).send({
      error: {
        code: 'internal_error',
        type: 'EventHandlingFailed',
        message: err instanceof Error ? err.message : 'unknown',
      },
    });
  }
}

async function dispatchEvent(db: Db, event: StripeEventMinimal): Promise<void> {
  if (event.type === 'checkout.session.completed') {
    const obj = event.data.object as {
      client_reference_id?: string;
      metadata?: { customer_id?: string };
      amount_total?: number;
      id?: string;
    };
    const customerId = obj.client_reference_id ?? obj.metadata?.customer_id;
    const sessionId = obj.id;
    const amount = obj.amount_total;
    if (!customerId || !sessionId || typeof amount !== 'number') {
      throw new Error('checkout.session.completed missing customer_id / session_id / amount');
    }
    await billing.creditTopup(db, {
      customerId,
      stripeSessionId: sessionId,
      amountUsdCents: BigInt(amount),
    });
    return;
  }

  if (event.type === 'charge.dispute.created') {
    const obj = event.data.object as {
      payment_intent?: string;
      charge?: string;
      metadata?: { stripe_session_id?: string };
    };
    const sessionId = obj.metadata?.stripe_session_id;
    if (sessionId) {
      await billing.markTopupDisputed(db, sessionId);
    }
    return;
  }

  // Other event types: acknowledge and ignore.
}
