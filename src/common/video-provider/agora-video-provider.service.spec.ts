import { ConfigService } from '@nestjs/config';
import { agoraUidFor, AgoraVideoProvider } from './agora-video-provider.service';

describe('AgoraVideoProvider', () => {
  function makeProvider(overrides: Record<string, string> = {}) {
    const config = { get: (key: string) => overrides[key] } as unknown as ConfigService;
    return new AgoraVideoProvider(config);
  }

  it('derives a stable channel name from the stream id', () => {
    const provider = makeProvider();
    expect(provider.createChannelName('abc123')).toBe('stream_abc123');
  });

  it('gives the pre-live preview just the app id', () => {
    const provider = makeProvider({ AGORA_APP_ID: 'app-id' });
    expect(provider.getClientConfig()).toEqual({ provider: 'AGORA', appId: 'app-id' });
  });

  it('needs no server call to open or close a channel', async () => {
    const provider = makeProvider();
    await expect(provider.openChannel()).resolves.toBeUndefined();
    await expect(provider.closeChannel()).resolves.toBeUndefined();
  });

  it('mints a placeholder token when Agora credentials are not configured', async () => {
    const provider = makeProvider();

    const result = await provider.mintToken({
      channelName: 'stream_abc123',
      userId: 'user-1',
      role: 'audience',
    });

    expect(result.token.startsWith('placeholder.')).toBe(true);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('signs the placeholder token when an app certificate is configured without an app id', async () => {
    const provider = makeProvider({ AGORA_APP_CERTIFICATE: 'cert' });

    const result = await provider.mintToken({
      channelName: 'stream_abc123',
      userId: 'user-1',
      role: 'publisher',
      ttlSeconds: 60,
    });

    expect(result.token.split('.')).toHaveLength(3);
  });

  it('mints a real Agora RTC token once both app id and certificate are configured', async () => {
    // Agora requires both to be exactly 32-char hex strings, or the
    // underlying builder silently returns '' - see buildRealToken().
    const provider = makeProvider({
      AGORA_APP_ID: 'a'.repeat(32),
      AGORA_APP_CERTIFICATE: 'b'.repeat(32),
    });

    const result = await provider.mintToken({
      channelName: 'stream_abc123',
      userId: 'user-1',
      role: 'publisher',
      ttlSeconds: 60,
    });

    expect(result).toMatchObject({ provider: 'AGORA', appId: 'a'.repeat(32) });
    expect(result.token.startsWith('placeholder.')).toBe(false);
    expect(result.token.startsWith('007')).toBe(true);
  });

  it('throws if the configured app id/certificate are not valid 32-char hex strings', async () => {
    const provider = makeProvider({ AGORA_APP_ID: 'app-id', AGORA_APP_CERTIFICATE: 'cert' });

    await expect(
      provider.mintToken({ channelName: 'stream_abc123', userId: 'user-1', role: 'publisher' }),
    ).rejects.toThrow(/32-character hex string/);
  });

  it('mints the same uid for the same user every time, and different uids for different users', async () => {
    const provider = makeProvider();

    const first = await provider.mintToken({ channelName: 's1', userId: 'user-1', role: 'audience' });
    const again = await provider.mintToken({ channelName: 's2', userId: 'user-1', role: 'publisher' });
    const other = await provider.mintToken({ channelName: 's1', userId: 'user-2', role: 'audience' });

    expect(first.uid).toBe(again.uid);
    expect(first.uid).not.toBe(other.uid);
  });
});

describe('agoraUidFor', () => {
  it('never returns 0 - reserved by Agora as the let-the-server-assign wildcard', () => {
    // Try enough distinct inputs that a naive modulo implementation would
    // very likely hit 0 for at least one of them if it didn't guard for it.
    for (let i = 0; i < 500; i++) {
      expect(agoraUidFor(`user-${i}`)).not.toBe(0);
    }
  });

  it('fits in a 32-bit unsigned integer, as Agora requires', () => {
    expect(agoraUidFor('some-user-id')).toBeLessThanOrEqual(0xffffffff);
    expect(agoraUidFor('some-user-id')).toBeGreaterThan(0);
  });
});
