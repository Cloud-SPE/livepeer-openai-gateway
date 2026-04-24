import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AuthenticatedCaller, AuthService } from '../../../service/auth/authenticate.js';
import { AuthError } from '../../../service/auth/errors.js';
import type { ErrorEnvelope } from '../../../types/error.js';

declare module 'fastify' {
  interface FastifyRequest {
    caller?: AuthenticatedCaller;
  }
}

export function authPreHandler(authService: AuthService): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const header = req.headers.authorization;
      const caller = await authService.authenticate(header);
      req.caller = caller;
    } catch (err) {
      if (err instanceof AuthError) {
        const envelope: ErrorEnvelope = {
          error: {
            code: err.code,
            message: err.message,
            type: err.name,
          },
        };
        await reply.code(401).send(envelope);
        return;
      }
      throw err;
    }
  };
}
