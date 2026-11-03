import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { LiveStatsService } from './live-stats.service';

/** The timer behind LiveStatsService (kept apart: @nestjs/schedule doesn't load under Jest). */
@Injectable()
export class ActivityJobs {
  constructor(private readonly liveStats: LiveStatsService) {}

  @Interval(60_000)
  meter(): Promise<void> {
    return this.liveStats.meter();
  }
}
