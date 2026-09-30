import { RedisService } from '../redis/redis.service';
import { RateLimitService } from './rate-limit.service';

describe('RateLimitService', () => {
  const client = { eval: jest.fn() };
  const redis = { getClient: () => client } as unknown as RedisService;

  beforeEach(() => jest.clearAllMocks());

  it('takes a token from the key in one atomic script, and reports the wait when out', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    client.eval.mockResolvedValueOnce(0).mockResolvedValueOnce(750);
    const service = new RateLimitService(redis);

    await expect(service.take('ratelimit:x', { capacity: 3, refillMs: 1500 })).resolves.toBe(0);
    await expect(service.take('ratelimit:x', { capacity: 3, refillMs: 1500 })).resolves.toBe(750);

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('HMGET'),
      1,
      'ratelimit:x',
      3,
      1500,
      1_000_000,
    );
    jest.restoreAllMocks();
  });
});
