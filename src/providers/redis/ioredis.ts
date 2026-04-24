import { Redis } from 'ioredis';
import type { RedisClient, RedisConfig } from '../redis.js';

export function createIoRedisClient(config: RedisConfig): RedisClient {
  const client = new Redis({
    host: config.host,
    port: config.port,
    ...(config.password !== undefined ? { password: config.password } : {}),
    db: config.db ?? 0,
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  client.on('error', () => {
    // Swallow to avoid tripping unhandledError; callers fail-open.
  });

  return {
    async eval(script, keys, args) {
      return client.eval(script, keys.length, ...keys, ...args.map(String));
    },
    async incr(key) {
      return client.incr(key);
    },
    async decr(key) {
      return client.decr(key);
    },
    async expire(key, seconds) {
      return client.expire(key, seconds);
    },
    async ping() {
      return client.ping();
    },
    async close() {
      client.disconnect();
    },
  };
}
