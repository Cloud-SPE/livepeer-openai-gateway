import { loadDatabaseConfig } from '../src/config/database.ts';
import { createPgDatabase } from '../src/providers/database/pg/index.ts';
import { makeDb } from '../src/repo/db.ts';
import { runMigrations } from '../src/repo/migrate.ts';

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
