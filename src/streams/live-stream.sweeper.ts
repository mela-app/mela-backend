import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { StreamsService } from './streams.service';

const SWEEP_INTERVAL_MS = 30_000;

/**
 * Ends lives whose host vanished without tapping "End stream" (plan §6.1):
 * a live ends 90-120 s after its host's last heartbeat.
 */
@Injectable()
export class LiveStreamSweeper {
  private readonly logger = new Logger(LiveStreamSweeper.name);
  private sweeping = false;

  constructor(private readonly streams: StreamsService) {}

  @Interval(SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    // A slow database must not stack sweeps on top of each other.
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const ended = await this.streams.endAbandonedLives();
      if (ended > 0) this.logger.log(`Ended ${ended} live(s) whose host stopped responding`);
    } catch (error) {
      this.logger.warn(`Live sweep failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.sweeping = false;
    }
  }
}
