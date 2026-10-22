import { Module } from '@nestjs/common';
import { PresenceModule } from '../common/presence/presence.module';
import { VideoProviderModule } from '../common/video-provider/video-provider.module';
import { AgoraUsageClient } from './agora-usage.client';
import { VideoControlJobs } from './video-control.jobs';
import { VideoControlService } from './video-control.service';

/** Where new lives go, and Agora's free minutes (docs/features/video-provider.md). */
@Module({
  imports: [VideoProviderModule, PresenceModule],
  providers: [VideoControlService, VideoControlJobs, AgoraUsageClient],
  exports: [VideoControlService],
})
export class VideoControlModule {}
