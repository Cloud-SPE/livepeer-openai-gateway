import { loadDatabaseConfig } from '../config/database.js';
import { createPgDatabase } from '../providers/database/pg/index.js';
import { makeDb } from '../repo/db.js';
import { runMigrations } from '../repo/migrate.js';

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const database = createPgDatabase(config);
  try {
    await runMigrations(makeDb(database));
    console.warn('migrations applied');
  } finally {
    await database.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
