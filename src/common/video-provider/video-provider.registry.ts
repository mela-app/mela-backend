import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoProviderKind } from '@prisma/client';
import { AgoraVideoProvider } from './agora-video-provider.service';
import { LiveKitVideoProvider } from './livekit-video-provider.service';
import { VideoProvider } from './video-provider.interface';

/**
 * Both vendors stay wired up at all times: VIDEO_PROVIDER only decides where
 * new lives go, while a running live keeps using the vendor it started on.
 */
@Injectable()
export class VideoProviderRegistry {
  private readonly providers: Record<VideoProviderKind, VideoProvider>;
  private readonly activeKind: VideoProviderKind;

  constructor(config: ConfigService, agora: AgoraVideoProvider, livekit: LiveKitVideoProvider) {
    this.providers = { [VideoProviderKind.AGORA]: agora, [VideoProviderKind.LIVEKIT]: livekit };
    this.activeKind = parseProviderKind(config.get<string>('VIDEO_PROVIDER'));

    if (this.activeKind === VideoProviderKind.LIVEKIT && !livekit.isConfigured) {
      throw new Error('VIDEO_PROVIDER=livekit needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.');
    }
  }

  /** Where new lives go. */
  active(): VideoProvider {
    return this.providers[this.activeKind];
  }

  /** The vendor a stream went live on. */
  get(kind: VideoProviderKind): VideoProvider {
    return this.providers[kind];
  }
}

function parseProviderKind(value: string | undefined): VideoProviderKind {
  const normalized = (value?.trim() || VideoProviderKind.AGORA).toUpperCase();
  if (!Object.values(VideoProviderKind).includes(normalized as VideoProviderKind)) {
    throw new Error(`VIDEO_PROVIDER must be "agora" or "livekit" (got "${value}").`);
  }
  return normalized as VideoProviderKind;
}
