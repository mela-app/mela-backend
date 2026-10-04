import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoomServiceClient, ServerError, TokenVerifier } from 'livekit-server-sdk';
import { LiveKitVideoProvider } from './livekit-video-provider.service';

const API_KEY = 'test-key';
const API_SECRET = 'test-secret-that-is-at-least-32-chars';
const CONFIGURED = {
  LIVEKIT_URL: 'wss://livekit.example.com',
  LIVEKIT_API_KEY: API_KEY,
  LIVEKIT_API_SECRET: API_SECRET,
};

describe('LiveKitVideoProvider', () => {
  function makeProvider(values: Record<string, string> = CONFIGURED) {
    const config = { get: (key: string) => values[key] } as unknown as ConfigService;
    return new LiveKitVideoProvider(config);
  }

  async function claimsOf(token: string) {
    return new TokenVerifier(API_KEY, API_SECRET).verify(token);
  }

  afterEach(() => jest.restoreAllMocks());

  it('rejects a LIVEKIT_URL that clients could not connect to', () => {
    expect(() =>
      makeProvider({ ...CONFIGURED, LIVEKIT_URL: 'https://livekit.example.com' }),
    ).toThrow(/ws:\/\/ or wss:\/\//);
  });

  it('reports unconfigured and answers 503 instead of minting unusable tokens', async () => {
    const provider = makeProvider({});

    expect(provider.isConfigured).toBe(false);
    await expect(
      provider.mintToken({ channelName: 'stream_s1', userId: 'viewer-1', role: 'audience' }),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(provider.openChannel('stream_s1')).rejects.toThrow(ServiceUnavailableException);
  });

  it('lets the host publish camera and mic only, in their own room', async () => {
    const provider = makeProvider();

    const result = await provider.mintToken({
      channelName: 'stream_s1',
      userId: 'host-1',
      role: 'publisher',
    });

    expect(result).toMatchObject({ provider: 'LIVEKIT', url: 'wss://livekit.example.com' });
    const claims = await claimsOf(result.token);
    expect(claims.sub).toBe('host-1');
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'stream_s1',
      canSubscribe: true,
      canPublish: true,
      canPublishSources: ['camera', 'microphone'],
      canPublishData: false,
      hidden: false,
    });
  });

  it('gives viewers a subscribe-only, hidden identity', async () => {
    const provider = makeProvider();

    const result = await provider.mintToken({
      channelName: 'stream_s1',
      userId: 'viewer-1',
      role: 'audience',
    });

    const claims = await claimsOf(result.token);
    expect(claims.sub).toBe('viewer-1');
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'stream_s1',
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
      hidden: true,
    });
  });

  it('expires tokens after 15 minutes by default', async () => {
    const provider = makeProvider();
    const before = Math.floor(Date.now() / 1000);

    const result = await provider.mintToken({
      channelName: 'stream_s1',
      userId: 'viewer-1',
      role: 'audience',
    });

    const claims = await claimsOf(result.token);
    expect(claims.exp! - before).toBeGreaterThanOrEqual(15 * 60 - 1);
    expect(claims.exp! - before).toBeLessThanOrEqual(15 * 60 + 1);
  });

  it('creates the room with the reconnect grace before the live starts', async () => {
    const createRoom = jest
      .spyOn(RoomServiceClient.prototype, 'createRoom')
      .mockResolvedValue({} as never);
    const provider = makeProvider();

    await provider.openChannel('stream_s1');

    expect(createRoom).toHaveBeenCalledWith({
      name: 'stream_s1',
      emptyTimeout: 300,
      departureTimeout: 90,
    });
  });

  it('turns an unreachable server into a 503 for the app', async () => {
    jest
      .spyOn(RoomServiceClient.prototype, 'createRoom')
      .mockRejectedValue(new TypeError('fetch failed'));
    const provider = makeProvider();

    await expect(provider.openChannel('stream_s1')).rejects.toThrow(ServiceUnavailableException);
  });

  it('treats closing an already-closed room as done', async () => {
    jest
      .spyOn(RoomServiceClient.prototype, 'deleteRoom')
      .mockRejectedValue(new ServerError('not_found', 'room not found', 404, 'not_found'));
    const provider = makeProvider();

    await expect(provider.closeChannel('stream_s1')).resolves.toBeUndefined();
  });

  it('removes a participant, ignoring one who already left', async () => {
    const removeParticipant = jest
      .spyOn(RoomServiceClient.prototype, 'removeParticipant')
      .mockRejectedValue(new ServerError('not_found', 'participant not found', 404, 'not_found'));
    const provider = makeProvider();

    await expect(provider.revokeToken('stream_s1', 'viewer-1')).resolves.toBeUndefined();
    expect(removeParticipant).toHaveBeenCalledWith('stream_s1', 'viewer-1');
  });
});
