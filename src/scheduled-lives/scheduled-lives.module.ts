import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HostingRestrictionsModule } from '../hosting-restrictions/hosting-restrictions.module';
import { SocialModule } from '../social/social.module';
import { ScheduledLiveReminderJob } from './scheduled-live-reminder.job';
import { ScheduledLivesController } from './scheduled-lives.controller';
import { ScheduledLivesService } from './scheduled-lives.service';

/** Lives announced ahead - see ScheduledLivesService and docs/features/streams.md. */
@Module({
  imports: [AuthModule, SocialModule, HostingRestrictionsModule],
  controllers: [ScheduledLivesController],
  providers: [ScheduledLivesService, ScheduledLiveReminderJob],
})
export class ScheduledLivesModule {}
