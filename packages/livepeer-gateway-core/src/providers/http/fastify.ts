import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import rawBody from 'fastify-raw-body';
import type { HttpServer, HttpServerConfig } from '../http.js';

export async function createFastifyServer(config: HttpServerConfig = {}): Promise<HttpServer> {
  const app = Fastify({
    logger: config.logger ?? false,
    bodyLimit: config.bodyLimit ?? 1_048_576,
    disableRequestLogging: true,
    forceCloseConnections: true,
  });
  // Order + awaiting matters: fastify-raw-body attaches a preParsing hook that
  // only sees route config (`config.rawBody`) once its registration has
  // resolved. Any route defined against this instance must be added AFTER
  // `await app.register(...)`.
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });
  await app.register(sensible);

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
