import type { RedisClient } from '../../providers/redis.js';

const SEMAPHORE_TTL_SECONDS = 300;

// Bounded-decrement: never go below 0.
const DECR_BOUNDED_SCRIPT = `
local key = KEYS[1]
local v = tonumber(redis.call('GET', key) or '0')
if v <= 0 then
  return 0
end
return redis.call('DECR', key)
`;

export interface ConcurrencyResult {
  acquired: boolean;
  count: number;
  limit: number;
}

export async function acquireSlot(
  redis: RedisClient,
  key: string,
  limit: number,
): Promise<ConcurrencyResult> {
  const count = await redis.incr(key);
  await redis.expire(key, SEMAPHORE_TTL_SECONDS);
  if (count > limit) {
    await redis.eval(DECR_BOUNDED_SCRIPT, [key], []);
    return { acquired: false, count: limit, limit };
  }
  return { acquired: true, count, limit };
}

export async function releaseSlot(redis: RedisClient, key: string): Promise<void> {
  await redis.eval(DECR_BOUNDED_SCRIPT, [key], []);
}
