import { ConfigService } from '@nestjs/config';
import { AgoraVideoProvider } from './agora-video-provider.service';
import { LiveKitVideoProvider } from './livekit-video-provider.service';
import { VideoProviderRegistry } from './video-provider.registry';

describe('VideoProviderRegistry', () => {
  const agora = { kind: 'AGORA' } as AgoraVideoProvider;

  function makeRegistry(videoProvider: string | undefined, livekitConfigured = true) {
    const config = { get: () => videoProvider } as unknown as ConfigService;
    const livekit = {
      kind: 'LIVEKIT',
      isConfigured: livekitConfigured,
    } as unknown as LiveKitVideoProvider;
    return new VideoProviderRegistry(config, agora, livekit);
  }

  it('sends new lives to Agora unless told otherwise', () => {
    expect(makeRegistry(undefined).active().kind).toBe('AGORA');
  });

  it('switches new lives to LiveKit, case-insensitively', () => {
    expect(makeRegistry(' LiveKit ').active().kind).toBe('LIVEKIT');
  });

  it('still serves the other vendor for lives already running on it', () => {
    const registry = makeRegistry('livekit');

    expect(registry.get('AGORA')).toBe(agora);
  });

  it('refuses to start with an unknown provider', () => {
    expect(() => makeRegistry('zoom')).toThrow(/VIDEO_PROVIDER must be/);
  });

  it('refuses to start on LiveKit without its credentials', () => {
    expect(() => makeRegistry('livekit', false)).toThrow(/LIVEKIT_URL/);
  });

  it('switches where new lives go while running - only to a provider that is set up', () => {
    const registry = makeRegistry('agora', false);

    expect(() => registry.setActive('LIVEKIT')).toThrow(/isn't set up/);
    expect(registry.activeProvider).toBe('AGORA');

    const both = makeRegistry('agora');
    both.setActive('LIVEKIT');
    expect(both.active().kind).toBe('LIVEKIT');
    expect(both.defaultKind).toBe('AGORA');
  });
});
