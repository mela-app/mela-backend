import { LivePresenceService } from '../common/presence/live-presence.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { LIKE_RATE_LIMIT, LikesService } from './likes.service';

describe('LikesService', () => {
  const presence = { addLikes: jest.fn() };
  const rateLimit = { take: jest.fn() };
  const service = () =>
    new LikesService(
      presence as unknown as LivePresenceService,
      rateLimit as unknown as RateLimitService,
    );

  beforeEach(() => jest.clearAllMocks());

  it("adds a batch to the live's total and returns it", async () => {
    rateLimit.take.mockResolvedValue(0);
    presence.addLikes.mockResolvedValue(57);

    await expect(service().add('s1', 'user-1', 7)).resolves.toEqual({ ok: true, total: 57 });
    expect(presence.addLikes).toHaveBeenCalledWith('s1', 7);
    expect(rateLimit.take).toHaveBeenCalledWith('ratelimit:likes:s1:user-1', LIKE_RATE_LIMIT);
  });

  it('turns away batches over the rate limit', async () => {
    rateLimit.take.mockResolvedValue(400);

    await expect(service().add('s1', 'user-1', 30)).resolves.toEqual({
      ok: false,
      error: 'RATE_LIMITED',
      retryAfterMs: 400,
    });
    expect(presence.addLikes).not.toHaveBeenCalled();
  });
});
