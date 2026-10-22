import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoProviderKind } from '@prisma/client';
import { createHash, createHmac, randomBytes } from 'crypto';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import {
  MintTokenParams,
  VideoClientConfig,
  VideoCredentials,
  VideoProvider,
} from './video-provider.interface';

const DEFAULT_TTL_SECONDS = 4 * 60 * 60; // 4 hours

// What Agora's console shows for an App ID or App Certificate.
const AGORA_KEY = /^[0-9a-f]{32}$/i;
/**
 * A stable, deterministic Agora uid for a given user - the same user always
 * gets the same uid (in this channel or any other), so a client's
 * `onUserJoined(uid)` callback can be correlated back to a real person via
 * data the app already has (the join response's host id, a `guest:joined`
 * payload's userId, ...) without the backend having to track a separate
 * per-stream uid assignment table. 0 is reserved by Agora as a
 * let-the-server-assign wildcard, so never return it.
 */
export function agoraUidFor(userId: string): number {
  const hash = createHash('sha256').update(userId).digest();
  const value = hash.readUInt32BE(0) & 0x7fffffff;
  return value === 0 ? 1 : value;
}

/**
 * Agora implementation of VideoProvider.
 *
 * mintToken() mints a real Agora RTC token via `agora-token` once
 * AGORA_APP_ID/AGORA_APP_CERTIFICATE are set; otherwise it falls back to a
 * placeholder signed token so the rest of the app still runs end-to-end
 * without live Agora credentials (it just won't work against real Agora
 * infrastructure). Nothing outside this file needs to change either way -
 * callers only ever see the VideoProvider interface.
 */
@Injectable()
export class AgoraVideoProvider implements VideoProvider {
  readonly kind = VideoProviderKind.AGORA;
  private readonly logger = new Logger(AgoraVideoProvider.name);
  private readonly appId: string;
  private readonly appCertificate: string;

  constructor(private readonly config: ConfigService) {
    this.appId = this.config.get<string>('AGORA_APP_ID') ?? '';
    this.appCertificate = this.config.get<string>('AGORA_APP_CERTIFICATE') ?? '';

    if (!this.appId || !this.appCertificate) {
      this.logger.warn(
        'AGORA_APP_ID / AGORA_APP_CERTIFICATE are not set - mintToken() will return placeholder ' +
          'tokens that will not work against real Agora infrastructure.',
      );
    }
  }

  /**
   * Both credentials are set, each the 32-character hex string Agora's
   * console shows: tokens can work against real Agora. (A mistyped value
   * would make every go-live fail - the console won't switch to it.)
   */
  get isConfigured(): boolean {
    return AGORA_KEY.test(this.appId) && AGORA_KEY.test(this.appCertificate);
  }

  // The app ID is all the pre-live camera preview needs.
  getClientConfig(): VideoClientConfig {
    return { provider: VideoProviderKind.AGORA, appId: this.appId };
  }

  createChannelName(streamId: string): string {
    return `stream_${streamId}`;
  }

  // Agora channels exist as soon as someone joins with a valid token.
  async openChannel(): Promise<void> {}

  // Narrower than the VideoProvider interface's own `mintToken` signature
  // (a valid override - return-type covariance) so a caller that already
  // knows it's talking to THIS provider (not the general VideoProvider
  // interface) gets `uid` typed directly, no cast needed.
  async mintToken(
    params: MintTokenParams,
  ): Promise<Extract<VideoCredentials, { provider: typeof VideoProviderKind.AGORA }>> {
    const ttlSeconds = params.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const uid = agoraUidFor(params.userId);
    const token =
      this.appId && this.appCertificate
        ? this.buildRealToken(params, uid, ttlSeconds)
        : this.buildPlaceholderToken(params, expiresAt);

    return { provider: VideoProviderKind.AGORA, appId: this.appId, token, uid, expiresAt };
  }

  private buildRealToken(params: MintTokenParams, uid: number, ttlSeconds: number): string {
    const role = params.role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
    const token = RtcTokenBuilder.buildTokenWithUid(
      this.appId,
      this.appCertificate,
      params.channelName,
      uid,
      role,
      ttlSeconds,
      ttlSeconds,
    );

    // agora-token silently returns '' instead of throwing if appId/appCertificate
    // aren't valid 32-character hex strings - fail loudly instead of handing the
    // client a token that will only fail much later, inside the Agora SDK.
    if (!token) {
      throw new Error(
        'Failed to mint an Agora RTC token - AGORA_APP_ID/AGORA_APP_CERTIFICATE must each be a ' +
          '32-character hex string exactly as shown on the Agora console.',
      );
    }

    return token;
  }

  async revokeToken(channelName: string, userId: string): Promise<void> {
    this.logger.log(`revokeToken requested for channel=${channelName} user=${userId}`);
  }

  // Nothing to call without Agora's RESTful API credentials: the channel
  // closes once everyone leaves, and clients leave on `stream_ended`.
  async closeChannel(): Promise<void> {}

  private buildPlaceholderToken(params: MintTokenParams, expiresAt: Date): string {
    const payload = [
      params.channelName,
      params.userId,
      params.role,
      expiresAt.getTime(),
      randomBytes(8).toString('hex'),
    ].join(':');
    const encodedPayload = Buffer.from(payload).toString('base64url');

    if (!this.appCertificate) {
      return `placeholder.${encodedPayload}`;
    }

    const signature = createHmac('sha256', this.appCertificate).update(payload).digest('base64url');
    return `placeholder.${encodedPayload}.${signature}`;
  }
}
