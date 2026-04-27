import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AuthResolver, Caller } from '../../../interfaces/index.js';
import type { ErrorEnvelope } from '../../../types/error.js';

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
  }
}

/**
 * Engine pre-handler: calls the AuthResolver, attaches `req.caller` on
 * success, sends 401 with `code: 'authentication_failed'` on null. Other
 * errors propagate (Fastify's default handler maps them to 500).
 *
 * Shell-side route handlers narrow `caller.metadata` to access fields the
 * generic Caller doesn't carry (customer row, api-key row).
 */
export function authPreHandler(authResolver: AuthResolver): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const caller = await authResolver.resolve({
      headers: req.headers as Record<string, string | undefined>,
      ip: req.ip,
    });
    if (!caller) {
      const envelope: ErrorEnvelope = {
        error: {
          code: 'authentication_failed',
          message: 'authentication required',
          type: 'AuthError',
        },
      };
      await reply.code(401).send(envelope);
      return;
    }
    req.caller = caller;
  };
}
