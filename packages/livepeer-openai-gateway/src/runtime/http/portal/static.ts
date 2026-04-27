import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

export interface PortalStaticOptions {
  /** Filesystem path to the built portal dist/. Defaults to <cwd>/bridge-ui/portal/dist. */
  rootDir?: string;
  /** URL prefix the portal is mounted at. Defaults to /portal. */
  prefix?: string;
}

/**
 * Register @fastify/static to serve the customer portal SPA at /portal/*.
 * Hash routing means only index.html needs SPA fallback. If the dist directory
 * is missing (e.g. running from a server-only image), logs a warning and
 * skips registration so the bridge can still serve /v1/* routes.
 */
export async function registerPortalStatic(
  app: FastifyInstance,
  options: PortalStaticOptions = {},
): Promise<void> {
  const rootDir = options.rootDir ?? resolve(process.cwd(), 'bridge-ui/portal/dist');
  const prefix = options.prefix ?? '/portal/';

  if (!existsSync(rootDir)) {
    app.log.warn({ rootDir }, 'portal: dist not found, skipping static mount');
    return;
  }

  await app.register(fastifyStatic, {
    root: rootDir,
    prefix,
    decorateReply: false,
  });
}
