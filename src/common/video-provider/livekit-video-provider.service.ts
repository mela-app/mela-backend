import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoProviderKind } from '@prisma/client';
import { AccessToken, RoomServiceClient, ServerError, TrackSource } from 'livekit-server-sdk';
import {
  MintTokenParams,
  VideoClientConfig,
  VideoCredentials,
  VideoProvider,
} from './video-provider.interface';

// Only has to cover minting -> connecting: the server keeps refreshing the
// token of a connected client. Also caps how long a kicked user's token works.
const DEFAULT_TTL_SECONDS = 15 * 60;
// Keeps an emptied room around for the plan's host-reconnect window (§6.1).
const DEPARTURE_TIMEOUT_SECONDS = 90;
// Closes a room whose host never connected.
const EMPTY_TIMEOUT_SECONDS = 5 * 60;

const UNAVAILABLE_MESSAGE = 'Live video is unavailable right now. Please try again in a moment.';

/**
 * Self-hosted LiveKit implementation of VideoProvider - see
 * docs/features/video-provider.md. The server runs with `room.auto_create:
 * false`, so rooms exist only between openChannel() and closeChannel() and a
 * leftover token can't bring an ended live back.
 */
@Injectable()
export class LiveKitVideoProvider implements VideoProvider {
  readonly kind = VideoProviderKind.LIVEKIT;
  private readonly logger = new Logger(LiveKitVideoProvider.name);
  private readonly url: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly rooms: RoomServiceClient | null;

  constructor(config: ConfigService) {
    this.url = config.get<string>('LIVEKIT_URL')?.trim() ?? '';
    this.apiKey = config.get<string>('LIVEKIT_API_KEY')?.trim() ?? '';
    this.apiSecret = config.get<string>('LIVEKIT_API_SECRET')?.trim() ?? '';

    if (this.url && !/^wss?:\/\//.test(this.url)) {
      throw new Error(`LIVEKIT_URL must start with ws:// or wss:// (got "${this.url}").`);
    }

    // The backend can reach LiveKit privately (e.g. http://127.0.0.1:7880 on
    // the same server) while apps use the public wss:// address.
    const apiUrl = config.get<string>('LIVEKIT_API_URL')?.trim() || this.url;
    this.rooms = this.isConfigured ? new RoomServiceClient(apiUrl, this.apiKey, this.apiSecret) : null;
  }

  get isConfigured(): boolean {
    return Boolean(this.url && this.apiKey && this.apiSecret);
  }

  // The preview only opens the local camera - no server details needed.
  getClientConfig(): VideoClientConfig {
    return { provider: VideoProviderKind.LIVEKIT };
  }

  createChannelName(streamId: string): string {
    return `stream_${streamId}`;
  }

  async openChannel(channelName: string): Promise<void> {
    await this.callRoomService('createRoom', (rooms) =>
      rooms.createRoom({
        name: channelName,
        emptyTimeout: EMPTY_TIMEOUT_SECONDS,
        departureTimeout: DEPARTURE_TIMEOUT_SECONDS,
      }),
    );
  }

  async mintToken(params: MintTokenParams): Promise<VideoCredentials> {
    this.assertConfigured();
    const ttlSeconds = params.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const isPublisher = params.role === 'publisher';

    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: params.userId,
      ttl: ttlSeconds,
    });
    token.addGrant({
      roomJoin: true,
      room: params.channelName,
      canSubscribe: true,
      canPublish: isPublisher,
      // Camera and mic only - no screen sharing.
      ...(isPublisher && { canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE] }),
      // Chat and live events go through Socket.IO, where moderation runs.
      canPublishData: false,
      // Viewers aren't listed as room participants: nobody needs the list
      // (viewer counts come from Socket.IO), and every join/leave would
      // otherwise be pushed to everyone in the room.
      hidden: !isPublisher,
    });

    return {
      provider: VideoProviderKind.LIVEKIT,
      url: this.url,
      token: await token.toJwt(),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  async revokeToken(channelName: string, userId: string): Promise<void> {
    await this.callRoomService('removeParticipant', (rooms) => rooms.removeParticipant(channelName, userId), {
      ignoreNotFound: true,
    });
  }

  async closeChannel(channelName: string): Promise<void> {
    await this.callRoomService('deleteRoom', (rooms) => rooms.deleteRoom(channelName), { ignoreNotFound: true });
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      this.logger.error('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set.');
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
  }

  private async callRoomService(
    action: string,
    request: (rooms: RoomServiceClient) => Promise<unknown>,
    { ignoreNotFound = false } = {},
  ): Promise<void> {
    this.assertConfigured();
    try {
      await request(this.rooms!);
    } catch (error) {
      if (ignoreNotFound && error instanceof ServerError && error.code === 'not_found') {
        return;
      }
      this.logger.error(`LiveKit ${action} failed: ${error instanceof Error ? error.message : error}`);
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
  }
}
