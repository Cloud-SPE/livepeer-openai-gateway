import type { RedisClient } from '../../providers/redis.js';

// Atomic sliding-window: purge old entries (score < now - windowMs),
// count remaining, if under limit ZADD current request, return {count, limit, allowed}.
// KEYS[1] = ZSET key, ARGV[1] = now (ms), ARGV[2] = windowMs, ARGV[3] = limit,
// ARGV[4] = member (unique string for this request).
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
local allowed = 0
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  count = count + 1
  allowed = 1
end
local oldestScore = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetMs = windowMs
if #oldestScore == 2 then
  resetMs = (tonumber(oldestScore[2]) + windowMs) - now
  if resetMs < 0 then resetMs = 0 end
end
return { allowed, count, limit, resetMs }
`;

export interface WindowResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetSeconds: number;
}

export async function checkWindow(
  redis: RedisClient,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
  member: string,
): Promise<WindowResult> {
  const raw = (await redis.eval(
    SLIDING_WINDOW_SCRIPT,
    [key],
    [String(now), String(windowMs), String(limit), member],
  )) as [number, number, number, number];
  const [allowed, count, outLimit, resetMs] = raw;
  return {
    allowed: allowed === 1,
    count,
    limit: outLimit,
    resetSeconds: Math.max(0, Math.ceil(resetMs / 1000)),
  };
}
