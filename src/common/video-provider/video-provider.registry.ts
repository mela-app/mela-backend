import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoProviderKind } from '@prisma/client';
import { AgoraVideoProvider } from './agora-video-provider.service';
import { LiveKitVideoProvider } from './livekit-video-provider.service';
import { VideoProvider } from './video-provider.interface';

/**
 * Both vendors stay wired up at all times: the active one decides where new
 * lives go - VIDEO_PROVIDER until staff switch it from the console (saved,
 * see VideoControlService) - while a running live keeps using the vendor it
 * started on.
 */
@Injectable()
export class VideoProviderRegistry {
  private readonly providers: Record<VideoProviderKind, VideoProvider>;
  private readonly configured: Record<VideoProviderKind, boolean>;
  /** VIDEO_PROVIDER: where new lives go until staff choose (docs/features/video-provider.md). */
  readonly defaultKind: VideoProviderKind;
  private activeKind: VideoProviderKind;

  constructor(config: ConfigService, agora: AgoraVideoProvider, livekit: LiveKitVideoProvider) {
    this.providers = { [VideoProviderKind.AGORA]: agora, [VideoProviderKind.LIVEKIT]: livekit };
    // Agora without credentials still runs (placeholder tokens, in development).
    this.configured = {
      [VideoProviderKind.AGORA]: agora.isConfigured !== false,
      [VideoProviderKind.LIVEKIT]: livekit.isConfigured,
    };
    this.defaultKind = parseProviderKind(config.get<string>('VIDEO_PROVIDER'));
    this.activeKind = this.defaultKind;

    if (this.activeKind === VideoProviderKind.LIVEKIT && !livekit.isConfigured) {
      throw new Error(
        'VIDEO_PROVIDER=livekit needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.',
      );
    }
  }

  /** Where new lives go. */
  active(): VideoProvider {
    return this.providers[this.activeKind];
  }

  get activeProvider(): VideoProviderKind {
    return this.activeKind;
  }

  /** Its credentials are set: lives can go to it. */
  isConfigured(kind: VideoProviderKind): boolean {
    return this.configured[kind];
  }

  /**
   * Sends new lives to [kind] from now on - running ones stay where they
   * started. Refused for a provider without its credentials.
   */
  setActive(kind: VideoProviderKind): void {
    if (!this.configured[kind]) {
      throw new Error(`${kind} isn't set up on this server (its credentials are missing).`);
    }
    this.activeKind = kind;
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
