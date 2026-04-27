import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthResolver } from '@cloudspe/livepeer-gateway-core/interfaces/index.js';
import type { StripeClient } from '../../../providers/stripe.js';
import type { StripeConfig } from '../../../config/stripe.js';
import { authPreHandler } from '@cloudspe/livepeer-gateway-core/runtime/http/middleware/auth.js';
import { toHttpError } from '@cloudspe/livepeer-gateway-core/runtime/http/errors.js';

const TopupRequestSchema = z.object({
  amount_usd_cents: z.number().int().positive(),
});

export interface TopupRouteDeps {
  authResolver: AuthResolver;
  stripe: StripeClient;
  config: StripeConfig;
}

export function registerTopupRoute(app: FastifyInstance, deps: TopupRouteDeps): void {
  app.post('/v1/billing/topup', { preHandler: authPreHandler(deps.authResolver) }, (req, reply) =>
    handleTopup(req, reply, deps),
  );
}

async function handleTopup(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: TopupRouteDeps,
): Promise<void> {
  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }

  const parsed = TopupRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const { status, envelope } = toHttpError(parsed.error);
    await reply.code(status).send(envelope);
    return;
  }

  const amount = parsed.data.amount_usd_cents;
  if (amount < deps.config.priceMinCents || amount > deps.config.priceMaxCents) {
    await reply.code(400).send({
      error: {
        code: 'invalid_request_error',
        type: 'InvalidAmountError',
        message: `amount_usd_cents must be between ${deps.config.priceMinCents} and ${deps.config.priceMaxCents}`,
      },
    });
    return;
  }

  try {
    const session = await deps.stripe.createCheckoutSession({
      customerId: caller.id,
      amountUsdCents: amount,
      successUrl: deps.config.successUrl,
      cancelUrl: deps.config.cancelUrl,
    });
    await reply.code(200).send({ url: session.url, session_id: session.sessionId });
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}
