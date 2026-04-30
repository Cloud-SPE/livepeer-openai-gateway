import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { createPgDatabase } from '@cloudspe/livepeer-openai-gateway-core/providers/database/pg/index.js';
import type {
  Database,
  DatabaseConfig,
} from '@cloudspe/livepeer-openai-gateway-core/providers/database.js';
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
  const adminConfig: DatabaseConfig = {
    host,
    port: Number(process.env.TEST_PG_PORT ?? '5432'),
    user: process.env.TEST_PG_USER ?? 'postgres',
    password: process.env.TEST_PG_PASSWORD ?? 'postgres',
    database: process.env.TEST_PG_DATABASE ?? 'postgres',
  };
  const isolatedDatabase = `bridge_test_${randomUUID().replace(/-/g, '')}`;
  const adminDatabase = createPgDatabase(adminConfig);
  try {
    await adminDatabase.pool.query(`CREATE DATABASE "${isolatedDatabase}"`);
  } finally {
    await adminDatabase.end();
  }
  const config: DatabaseConfig = {
    ...adminConfig,
    database: isolatedDatabase,
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
      const cleanupDatabase = createPgDatabase(adminConfig);
      try {
        await cleanupDatabase.pool.query(
          `
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = $1
              AND pid <> pg_backend_pid()
          `,
          [isolatedDatabase],
        );
        await cleanupDatabase.pool.query(`DROP DATABASE IF EXISTS "${isolatedDatabase}"`);
      } finally {
        await cleanupDatabase.end();
      }
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
