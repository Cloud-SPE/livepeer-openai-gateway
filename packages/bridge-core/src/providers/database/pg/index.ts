import pg from 'pg';
import type { Database, DatabaseConfig } from '../../database.js';

export function createPgDatabase(config: DatabaseConfig): Database {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: config.max ?? 10,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  });

  return {
    pool,
    async end(): Promise<void> {
      await pool.end();
    },
  };
}
