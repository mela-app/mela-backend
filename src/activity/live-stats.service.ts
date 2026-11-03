import { Injectable, Logger } from '@nestjs/common';
import { StreamStatus } from '@prisma/client';
import { LivePresenceService } from '../common/presence/live-presence.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

// Everyone who watched a live, while it runs; long enough for any live.
const WATCHED_TTL_SECONDS = 24 * 60 * 60;

const watchedKey = (streamId: string) => `stream:${streamId}:watched`;

/**
 * Watching, counted once a minute on one instance (a Redis key per
 * minute): every viewer of a running live adds a minute to its
 * `viewerMinutes`, and `uniqueViewers` is how many different people
 * watched it so far. The host isn't a viewer.
 */
@Injectable()
export class LiveStatsService {
  private readonly logger = new Logger(LiveStatsService.name);
  private counting = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: LivePresenceService,
    private readonly redis: RedisService,
  ) {}

  async meter(now: Date = new Date()): Promise<void> {
    if (this.counting) return;
    this.counting = true;
    try {
      const client = this.redis.getClient();
      const minute = Math.floor(now.getTime() / 60_000);
      if ((await client.set(`live-stats:minute:${minute}`, '1', 'EX', 180, 'NX')) !== 'OK') return;
      const lives = await this.prisma.stream.findMany({
        where: { status: StreamStatus.LIVE },
        select: { id: true },
      });
      const updates = [];
      for (const live of lives) {
        const viewers = await this.presence.viewerIds(live.id);
        if (viewers.length === 0) continue;
        const [, , unique] = (await client
          .multi()
          .sadd(watchedKey(live.id), ...viewers)
          .expire(watchedKey(live.id), WATCHED_TTL_SECONDS)
          .scard(watchedKey(live.id))
          .exec()) as Array<[Error | null, unknown]>;
        updates.push(
          this.prisma.stream.updateMany({
            where: { id: live.id, status: StreamStatus.LIVE },
            data: {
              viewerMinutes: { increment: viewers.length },
              uniqueViewers: Number(unique?.[1] ?? 0),
            },
          }),
        );
      }
      if (updates.length > 0) await this.prisma.$transaction(updates);
    } catch (error) {
      this.logger.warn(`Live watching not counted: ${error}`);
    } finally {
      this.counting = false;
    }
  }
}
