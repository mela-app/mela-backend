import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PresenceModule } from '../common/presence/presence.module';
import { ActivityController } from './activity.controller';
import { ActivityInterceptor } from './activity.interceptor';
import { ActivityJobs } from './activity.jobs';
import { ActivityService } from './activity.service';
import { LiveStatsService } from './live-stats.service';

/** Who uses Mela, how much they watch, and where installs come from (docs/features/analytics.md). */
@Module({
  imports: [PresenceModule],
  controllers: [ActivityController],
  providers: [
    ActivityService,
    LiveStatsService,
    ActivityJobs,
    { provide: APP_INTERCEPTOR, useClass: ActivityInterceptor },
  ],
  exports: [ActivityService],
})
export class ActivityModule {}
