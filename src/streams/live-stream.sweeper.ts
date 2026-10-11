import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RedisService } from '../common/redis/redis.service';
import { StreamsService } from './streams.service';

const SWEEP_INTERVAL_MS = 30_000;
// Frees the lock if the instance holding it dies mid-sweep.
const SWEEP_LOCK_TTL_MS = 25_000;

/**
 * Ends lives whose host vanished without tapping "End stream" (plan §6.1):
 * a live ends 90-120 s after its host's last heartbeat. With several API
 * instances, one sweeps per round (a Redis lock); the others skip it.
 */
@Injectable()
export class LiveStreamSweeper {
  private readonly logger = new Logger(LiveStreamSweeper.name);
  private sweeping = false;

  constructor(
    private readonly streams: StreamsService,
    private readonly redis: RedisService,
  ) {}

  @Interval(SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    // A slow database must not stack sweeps on top of each other.
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.redis.runExclusive('live-sweep', SWEEP_LOCK_TTL_MS, async () => {
        const ended = await this.streams.endAbandonedLives();
        if (ended > 0) this.logger.log(`Ended ${ended} live(s) whose host stopped responding`);
        const vacated = await this.streams.vacateDroppedGuests();
        if (vacated > 0) this.logger.log(`Took ${vacated} guest(s) whose video dropped off stage`);
      });
    } catch (error) {
      this.logger.warn(`Live sweep failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.sweeping = false;
    }
  }
}
