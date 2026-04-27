import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runMigrations as runEngineMigrations } from '@cloudspe/livepeer-openai-gateway-core/repo/migrate.js';
import type { Db } from './db.js';

// Shell migrations live alongside the package source: walk up from
// src/repo/migrate.ts → packages/livepeer-openai-gateway/migrations/.
const SHELL_MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

/**
 * Apply both schema migrations in order: engine first (creates `engine.*`
 * tables), shell second (creates `app.*` tables, possibly with FKs into
 * its own schema only). Idempotent — both runners use the same
 * `public.bridge_schema_migrations` tracker so re-runs are no-ops.
 */
export async function runMigrations(db: Db): Promise<void> {
  await runEngineMigrations(db);
  await runEngineMigrations(db, SHELL_MIGRATIONS);
}

export const SHELL_MIGRATIONS_FOLDER = SHELL_MIGRATIONS;
