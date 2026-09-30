import { VideoProviderKind } from '@prisma/client';

export type VideoPublishRole = 'publisher' | 'audience';

export interface MintTokenParams {
  channelName: string;
  userId: string;
  role: VideoPublishRole;
  ttlSeconds?: number;
}

/**
 * What a client needs to join a channel - shape depends on the vendor.
 * Agora's `uid` is a deterministic mapping of `userId` (plan §6.5/§6.6 -
 * multiple simultaneous broadcasters, host + guests, need a stable id a
 * viewer's client can correlate an `onUserJoined` callback back to a real
 * person; LiveKit needs no equivalent field since its `identity` grant
 * *is* `userId` already - see `agoraUidFor()`).
 */
export type VideoCredentials =
  | { provider: typeof VideoProviderKind.AGORA; appId: string; token: string; uid: number; expiresAt: Date }
  | { provider: typeof VideoProviderKind.LIVEKIT; url: string; token: string; expiresAt: Date };

/** What a client needs before joining anything (the pre-live camera preview). */
export type VideoClientConfig =
  | { provider: typeof VideoProviderKind.AGORA; appId: string }
  | { provider: typeof VideoProviderKind.LIVEKIT };

/**
 * Everything the rest of the app knows about a video vendor. No module
 * outside common/video-provider should import a vendor SDK directly - see
 * docs/features/video-provider.md.
 */
export interface VideoProvider {
  readonly kind: VideoProviderKind;
  getClientConfig(): VideoClientConfig;
  createChannelName(streamId: string): string;
  // Called before the stream row exists, so a vendor outage fails go-live
  // cleanly instead of leaving a LIVE stream nobody can join.
  openChannel(channelName: string): Promise<void>;
  mintToken(params: MintTokenParams): Promise<VideoCredentials>;
  // Disconnects one participant now. Their token stays valid until it
  // expires (Agora tokens are stateless; self-hosted LiveKit keeps no
  // revocation list), so bans must also be enforced where tokens are minted.
  revokeToken(channelName: string, userId: string): Promise<void>;
  // Ends all media in the channel (stream ended or locked).
  closeChannel(channelName: string): Promise<void>;
}

