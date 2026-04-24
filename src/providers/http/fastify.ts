import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { HttpServer, HttpServerConfig } from '../http.js';

export function createFastifyServer(config: HttpServerConfig = {}): HttpServer {
  const app = Fastify({
    logger: config.logger ?? false,
    bodyLimit: config.bodyLimit ?? 1_048_576,
    disableRequestLogging: true,
  });
  app.register(sensible);

  return {
    app,
    async listen({ host, port }) {
      return app.listen({ host, port });
    },
    async close() {
      await app.close();
    },
  };
}
