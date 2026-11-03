import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsJobs } from './campaigns.jobs';
import { CampaignsService } from './campaigns.service';

/** Push campaigns, in-app banners and featured hosts (docs/features/campaigns.md). */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignsJobs],
  exports: [CampaignsService],
})
export class CampaignsModule {}
