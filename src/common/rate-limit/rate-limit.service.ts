import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/** A token bucket: `capacity` actions at once, then one more every `refillMs`. */
export interface RateLimit {
  capacity: number;
  refillMs: number;
}

// Returns 0 when a token was taken, else the milliseconds until the next one.
const TAKE_TOKEN = `
local capacity = tonumber(ARGV[1])
local refill_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1]) or capacity
local at = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - at) / refill_ms)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) * refill_ms)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * refill_ms))
return wait`;

/** Per-user limits on realtime actions (chat, likes), atomic in Redis. See docs/features/chat.md. */
@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  /** Takes one token; resolves to 0 when allowed, else how long until the next one (ms). */
  async take(key: string, limit: RateLimit): Promise<number> {
    const wait = await this.redis
      .getClient()
      .eval(TAKE_TOKEN, 1, key, limit.capacity, limit.refillMs, Date.now());
    return Number(wait);
  }
}
