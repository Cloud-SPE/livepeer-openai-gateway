// Fastify factory for the metrics HTTP server. Lives in providers/ because the
// project's lint rule (`no-cross-cutting-import`) forbids importing fastify
// outside src/providers/. The customer-facing HTTP server uses
// providers/http/fastify.ts; we deliberately keep the metrics server in its
// own factory because it has zero of the customer-facing middleware
// (sensible, raw-body, auth) — the metrics surface is bare on purpose.

import Fastify, { type FastifyInstance } from 'fastify';

/** createMetricsFastify returns a bare Fastify instance with logging disabled. */
export function createMetricsFastify(): FastifyInstance {
  return Fastify({ logger: false, disableRequestLogging: true });
}
