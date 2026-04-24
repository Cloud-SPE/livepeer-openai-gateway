import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { RateLimiter } from '../../../service/rateLimit/index.js';
import { RateLimitExceededError } from '../../../service/rateLimit/errors.js';
import type { ErrorEnvelope } from '../../../types/error.js';

declare module 'fastify' {
  interface FastifyRequest {
    rateLimit?: {
      concurrencyKey: string;
      failedOpen: boolean;
    };
  }
}

export function rateLimitPreHandler(limiter: RateLimiter): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.caller) return;

    try {
      const result = await limiter.check(req.caller.customer.id, req.caller.customer.rateLimitTier);
      reply.header('x-ratelimit-limit-requests', String(result.headers.limitRequests));
      reply.header('x-ratelimit-remaining-requests', String(result.headers.remainingRequests));
      reply.header('x-ratelimit-reset-requests', String(result.headers.resetSeconds));
      req.rateLimit = {
        concurrencyKey: result.concurrencyKey,
        failedOpen: result.failedOpen,
      };
      reply.raw.on('close', () => {
        void limiter.release(result.concurrencyKey, result.failedOpen);
      });
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        const envelope: ErrorEnvelope = {
          error: {
            code: 'rate_limit_exceeded',
            type: err.name,
            message: err.message,
          },
        };
        reply.header('retry-after', String(err.retryAfterSeconds));
        reply.header('x-ratelimit-limit-requests', String(err.limit));
        reply.header('x-ratelimit-remaining-requests', '0');
        reply.header('x-ratelimit-reset-requests', String(err.retryAfterSeconds));
        await reply.code(429).send(envelope);
        return;
      }
      throw err;
    }
  };
}
