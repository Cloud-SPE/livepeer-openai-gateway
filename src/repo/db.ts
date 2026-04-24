import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Database } from '../providers/database.js';
import { schema } from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function makeDb(database: Database): Db {
  return drizzle(database.pool, { schema });
}
