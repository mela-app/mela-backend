import { Module } from '@nestjs/common';
import { AgoraVideoProvider } from './agora-video-provider.service';
import { LiveKitVideoProvider } from './livekit-video-provider.service';
import { VideoProviderRegistry } from './video-provider.registry';

@Module({
  providers: [AgoraVideoProvider, LiveKitVideoProvider, VideoProviderRegistry],
  exports: [VideoProviderRegistry],
})
export class VideoProviderModule {}
