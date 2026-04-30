import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

export interface AdminConsoleStaticOptions {
  /** Filesystem path to frontend/admin/dist. */
  rootDir?: string;
  /** URL prefix the admin console is mounted at. */
  prefix?: string;
}

/**
 * Mount the operator admin SPA at /admin/console/*. The /admin/* JSON API is
 * registered separately by registerAdminRoutes; @fastify/static here decorates
 * its own scope with `decorateReply: false` to avoid collisions.
 */
export async function registerAdminConsoleStatic(
  app: FastifyInstance,
  options: AdminConsoleStaticOptions = {},
): Promise<void> {
  const rootDir = options.rootDir ?? resolve(process.cwd(), 'frontend/admin/dist');
  const prefix = options.prefix ?? '/admin/console/';

  if (!existsSync(rootDir)) {
    app.log.warn({ rootDir }, 'admin console: dist not found, skipping static mount');
    return;
  }

  await app.register(fastifyStatic, {
    root: rootDir,
    prefix,
    decorateReply: false,
  });
}
