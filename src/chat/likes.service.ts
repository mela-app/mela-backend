import { Injectable } from '@nestjs/common';
import { LivePresenceService } from '../common/presence/live-presence.service';
import { RateLimit, RateLimitService } from '../common/rate-limit/rate-limit.service';

/** The app sends a batch about once a second; this allows a short burst on top (plan §6.13). */
export const LIKE_RATE_LIMIT: RateLimit = { capacity: 3, refillMs: 1000 };

export type LikeResult =
  { ok: true; total: number } | { ok: false; error: 'RATE_LIMITED'; retryAfterMs: number };

@Injectable()
export class LikesService {
  constructor(
    private readonly presence: LivePresenceService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Adds a batch of taps to the live's running total, saved to `streams.likeCount` when it ends. */
  async add(streamId: string, userId: string, count: number): Promise<LikeResult> {
    const retryAfterMs = await this.rateLimit.take(
      `ratelimit:likes:${streamId}:${userId}`,
      LIKE_RATE_LIMIT,
    );
    if (retryAfterMs > 0) return { ok: false, error: 'RATE_LIMITED', retryAfterMs };
    return { ok: true, total: await this.presence.addLikes(streamId, count) };
  }
}
