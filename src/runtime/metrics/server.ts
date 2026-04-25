// Metrics HTTP server. Separate Fastify instance from the customer-facing one
// so a misconfigured port and a bad scrape can't break customer traffic, and
// so the metrics surface has zero auth, body limits, or middleware.
//
// When `listen` is empty/unset, createMetricsServer returns a no-op object
// whose start() is immediate, address() returns null, and stop() resolves.
// This mirrors the Go reference's NewListener returning nil for empty Addr.

import type { FastifyInstance } from 'fastify';
import { createMetricsFastify } from '../../providers/metrics/fastify.js';
import type { Recorder } from '../../providers/metrics/recorder.js';

/**
 * Listen spec: either "host:port" or "port" (defaults to 0.0.0.0:port). An
 * empty string (or undefined) disables the listener entirely.
 */
export interface MetricsServerOptions {
  readonly listen: string;
  readonly recorder: Recorder;
  /** Optional structured logger for lifecycle events. */
  readonly logger?: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void };
}

export interface MetricsServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Returns the bound address (e.g. "127.0.0.1:9100") once started, else null. */
  address(): string | null;
}

interface ParsedListen {
  host: string;
  port: number;
}

/** parseListen turns "host:port" or "port" into a {host, port} pair. */
function parseListen(spec: string): ParsedListen | null {
  if (!spec) return null;
  const trimmed = spec.trim();
  if (!trimmed) return null;
  const idx = trimmed.lastIndexOf(':');
  if (idx === -1) {
    const port = Number(trimmed);
    if (!Number.isFinite(port) || port < 0 || port > 65535) return null;
    return { host: '0.0.0.0', port };
  }
  const host = trimmed.slice(0, idx) || '0.0.0.0';
  const port = Number(trimmed.slice(idx + 1));
  if (!Number.isFinite(port) || port < 0 || port > 65535) return null;
  return { host, port };
}

/**
 * createMetricsServer builds (but does not yet bind) the metrics HTTP server.
 * Returns a no-op object when `listen` is empty so the call site can
 * unconditionally invoke `await server.start()`.
 */
export function createMetricsServer(opts: MetricsServerOptions): MetricsServer {
  const parsed = parseListen(opts.listen);
  if (!parsed) {
    return {
      async start() {},
      async stop() {},
      address() {
        return null;
      },
    };
  }

  let app: FastifyInstance | null = null;
  let bound: string | null = null;

  return {
    async start() {
      app = createMetricsFastify();

      app.get('/healthz', async (_req, reply) => {
        reply.code(200).send({ ok: true });
      });

      app.get('/metrics', async (_req, reply) => {
        const body = await opts.recorder.metricsText();
        reply.header('Content-Type', opts.recorder.metricsContentType());
        reply.send(body);
      });

      const addr = await app.listen({ host: parsed.host, port: parsed.port });
      bound = addr;
      opts.logger?.info('metrics listening', { addr, path: '/metrics' });
    },
    async stop() {
      if (!app) return;
      try {
        await app.close();
        opts.logger?.info('metrics stopped');
      } catch (err) {
        opts.logger?.warn('metrics shutdown error', { err: String(err) });
      } finally {
        app = null;
        bound = null;
      }
    },
    address() {
      return bound;
    },
  };
}
