import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createPgDatabase } from '../../providers/database/pg/index.js';
import type { Database, DatabaseConfig } from '../../providers/database.js';
import { makeDb, type Db } from '../../repo/db.js';
import { runMigrations } from '../../repo/migrate.js';

export interface TestPg {
  db: Db;
  database: Database;
  config: DatabaseConfig;
  close(): Promise<void>;
}

export async function startTestPg(): Promise<TestPg> {
  const envHost = process.env.TEST_PG_HOST;
  if (envHost) {
    return fromEnv(envHost);
  }
  return fromContainer();
}

async function fromEnv(host: string): Promise<TestPg> {
  const config: DatabaseConfig = {
    host,
    port: Number(process.env.TEST_PG_PORT ?? '5432'),
    user: process.env.TEST_PG_USER ?? 'postgres',
    password: process.env.TEST_PG_PASSWORD ?? 'postgres',
    database: process.env.TEST_PG_DATABASE ?? 'postgres',
  };
  const database = createPgDatabase(config);
  const db = makeDb(database);
  await runMigrations(db);
  return {
    db,
    database,
    config,
    async close() {
      await database.end();
    },
  };
}

async function fromContainer(): Promise<TestPg> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('bridge_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const config: DatabaseConfig = {
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
  };
  const database = createPgDatabase(config);
  const db = makeDb(database);
  await runMigrations(db);
  return {
    db,
    database,
    config,
    async close() {
      await database.end();
      await container.stop();
    },
  };
}
