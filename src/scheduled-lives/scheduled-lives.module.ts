import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SocialModule } from '../social/social.module';
import { ScheduledLiveReminderJob } from './scheduled-live-reminder.job';
import { ScheduledLivesController } from './scheduled-lives.controller';
import { ScheduledLivesService } from './scheduled-lives.service';

/** Lives announced ahead - see ScheduledLivesService and docs/features/streams.md. */
@Module({
  imports: [AuthModule, SocialModule],
  controllers: [ScheduledLivesController],
  providers: [ScheduledLivesService, ScheduledLiveReminderJob],
})
export class ScheduledLivesModule {}
