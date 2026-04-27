import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from './db.js';

// Engine migrations live alongside the package source: walk up from
// src/repo/migrate.ts → packages/livepeer-gateway-core/migrations/. The default is
// override-able so consuming packages (e.g. shell) can run their own
// migrations dir through the same runner.
const DEFAULT_ENGINE_MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

/**
 * Bookkeeping table for applied migrations. Lives in the public schema so
 * a single tracker covers both engine.* and app.* migrations — the file
 * basename uniquely identifies each migration regardless of which schema
 * it touches.
 */
const TRACKER_DDL = sql`
  CREATE TABLE IF NOT EXISTS public.bridge_schema_migrations (
    name        TEXT        PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

export async function runMigrations(
  db: Db,
  migrationsFolder: string = DEFAULT_ENGINE_MIGRATIONS,
): Promise<void> {
  await db.execute(TRACKER_DDL);

  const all = await readdir(migrationsFolder);
  const sqlFiles = all
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of sqlFiles) {
    const applied = await db.execute(
      sql`SELECT 1 FROM public.bridge_schema_migrations WHERE name = ${file}`,
    );
    if ((applied as unknown as { rows: unknown[] }).rows.length > 0) continue;

    const body = await readFile(path.join(migrationsFolder, file), 'utf8');
    await db.execute(sql.raw(body));
    await db.execute(
      sql`INSERT INTO public.bridge_schema_migrations (name) VALUES (${file})`,
    );
  }
}
