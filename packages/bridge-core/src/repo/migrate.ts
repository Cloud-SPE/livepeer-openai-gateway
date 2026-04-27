import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './db.js';

// Migrations live alongside the engine package source: walk up from
// src/repo/migrate.ts → packages/bridge-core/migrations/. This way the
// migrations folder is found regardless of the consuming package's cwd
// or build output layout.
const DEFAULT_MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export async function runMigrations(
  db: Db,
  migrationsFolder: string = DEFAULT_MIGRATIONS,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
