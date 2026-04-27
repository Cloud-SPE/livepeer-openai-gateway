import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Database } from '../providers/database.js';

/**
 * Schema-agnostic Drizzle handle. Repos import their own `schema.ts`
 * tables locally and rely on the SQL-builder API (`db.select()`,
 * `db.insert()`, etc.) for type safety; the schema generic on the Db
 * type would otherwise lock the handle to a single package's tables and
 * prevent the shell from passing its Db into engine repo functions.
 */
export type Db = NodePgDatabase<Record<string, never>>;

export function makeDb(database: Database): Db {
  return drizzle(database.pool);
}
