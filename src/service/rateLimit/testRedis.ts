import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { createIoRedisClient } from '../../providers/redis/ioredis.js';
import type { RedisClient, RedisConfig } from '../../providers/redis.js';

export interface TestRedis {
  client: RedisClient;
  config: RedisConfig;
  close(): Promise<void>;
}

export async function startTestRedis(): Promise<TestRedis> {
  const envHost = process.env.TEST_REDIS_HOST;
  if (envHost) {
    const config: RedisConfig = {
      host: envHost,
      port: Number(process.env.TEST_REDIS_PORT ?? '6379'),
    };
    const client = createIoRedisClient(config);
    await client.ping();
    return {
      client,
      config,
      async close() {
        await client.close();
      },
    };
  }

  const container: StartedTestContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const config: RedisConfig = {
    host: container.getHost(),
    port: container.getMappedPort(6379),
  };
  const client = createIoRedisClient(config);
  await client.ping();
  return {
    client,
    config,
    async close() {
      await client.close();
      await container.stop();
    },
  };
}
