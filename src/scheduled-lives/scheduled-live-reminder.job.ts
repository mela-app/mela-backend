import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RedisService } from '../common/redis/redis.service';
import { ScheduledLivesService } from './scheduled-lives.service';

const REMIND_EVERY_MS = 60_000;
// Frees the lock if the instance holding it dies mid-round.
const REMIND_LOCK_TTL_MS = 50_000;

/**
 * Sends scheduled lives' "starting soon" reminders every minute - on one API
 * instance per round (a Redis lock); the others skip it.
 */
@Injectable()
export class ScheduledLiveReminderJob {
  private readonly logger = new Logger(ScheduledLiveReminderJob.name);
  private running = false;

  constructor(
    private readonly scheduled: ScheduledLivesService,
    private readonly redis: RedisService,
  ) {}

  @Interval(REMIND_EVERY_MS)
  async run(): Promise<void> {
    // A slow database must not stack rounds on top of each other.
    if (this.running) return;
    this.running = true;
    try {
      await this.redis.runExclusive('scheduled-live-reminders', REMIND_LOCK_TTL_MS, async () => {
        const sent = await this.scheduled.sendDueReminders();
        if (sent > 0) this.logger.log(`Sent ${sent} scheduled live reminder(s)`);
      });
    } catch (error) {
      this.logger.warn(`Scheduled live reminders failed: ${error}`);
    } finally {
      this.running = false;
    }
  }
}
