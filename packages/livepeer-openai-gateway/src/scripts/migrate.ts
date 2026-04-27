// One-shot migration runner for the prod compose stack. Exits 0 on
// success, non-zero on failure. Runs engine migrations first
// (engine.* schema), then shell migrations (app.* schema) — same order
// the in-process auto-migrate path uses when BRIDGE_AUTO_MIGRATE=true.
import { loadDatabaseConfig } from '@cloud-spe/bridge-core/config/database.js';
import { createPgDatabase } from '@cloud-spe/bridge-core/providers/database/pg/index.js';
import { makeDb } from '../repo/db.js';
import { runMigrations } from '../repo/migrate.js';

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const database = createPgDatabase(config);
  try {
    await runMigrations(makeDb(database));
    console.warn('migrations applied (engine + app)');
  } finally {
    await database.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
