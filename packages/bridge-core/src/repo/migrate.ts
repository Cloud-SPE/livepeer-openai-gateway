import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './db.js';

export async function runMigrations(db: Db, migrationsFolder = './migrations'): Promise<void> {
  await migrate(db, { migrationsFolder });
}
