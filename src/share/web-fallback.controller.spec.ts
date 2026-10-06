import { ConfigService } from '@nestjs/config';
import { StreamStatus } from '@prisma/client';
import type { Response } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { PlayerConfig, WebFallbackController } from './web-fallback.controller';

const LIVE = '3f1c9a52-7c2e-4a8b-9d7e-2b6f0c1d4e5a';

// The required settings (.env) the page reads.
const APP: Record<string, string> = {
  APP_URL_SCHEME: 'gamblinglive',
  ANDROID_APP_PACKAGE_NAME: 'com.gamblinglive.app',
};

describe('WebFallbackController', () => {
  const findUnique = jest.fn();
  const prisma = { stream: { findUnique } };
  const config = { get: jest.fn(), getOrThrow: jest.fn() };
  const send = jest.fn();
  const setHeader = jest.fn();
  const res = { send, setHeader } as unknown as Response;
  const controller = new WebFallbackController(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
  );
  const page = () => send.mock.calls[0][0] as string;
  const header = (name: string) =>
    setHeader.mock.calls.find(([key]) => key === name)?.[1] as string | undefined;
  const playerConfig = (): PlayerConfig => {
    const json = /<script id="mela-player-config" type="application\/json">(.*?)<\/script>/.exec(
      page(),
    )?.[1];
    return JSON.parse(json ?? 'null') as PlayerConfig;
  };

  const requiredSettings = (settings: Record<string, string>) => (key: string) => {
    if (!(key in settings)) throw new Error(`${key} is not set`);
    return settings[key];
  };

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReset();
    config.getOrThrow.mockReset().mockImplementation(requiredSettings(APP));
  });

  it('previews a live with a deep link into the app, escaping what users wrote', async () => {
    findUnique.mockResolvedValue({
      title: '<script>alert(1)</script> Big night',
      status: StreamStatus.LIVE,
      host: { displayName: 'Ana & "Co"' },
    });

    await controller.show(LIVE, res);

    expect(page()).toContain(
      '<title>&lt;script&gt;alert(1)&lt;/script&gt; Big night - Mela</title>',
    );
    expect(page()).not.toContain('<script>alert');
    expect(page()).toContain('Ana &amp; &quot;Co&quot; is live now on Mela');
    expect(page()).toContain(`href="gamblinglive://live/${LIVE}"`);
    expect(page()).toContain('aria-label="Mela"');
  });

  it('loads the browser player over a live, with what it needs and a policy that lets video through', async () => {
    findUnique.mockResolvedValue({
      title: 'Big night',
      status: StreamStatus.LIVE,
      host: { displayName: 'Ana' },
    });

    await controller.show(LIVE, res);

    expect(page()).toContain('<script type="module" src="/web/player.js"></script>');
    expect(page()).toContain('<link rel="stylesheet" href="/web/player.css" />');
    expect(playerConfig()).toEqual({
      streamId: LIVE,
      appScheme: 'gamblinglive',
      androidPackage: 'com.gamblinglive.app',
      androidInstallUrl: 'https://play.google.com/store/apps/details?id=com.gamblinglive.app',
      iosInstallUrl: null,
    });
    expect(header('Content-Type')).toBe('text/html; charset=utf-8');
    expect(header('Content-Security-Policy')).toContain("connect-src 'self' https: wss:");
    expect(header('Content-Security-Policy')).toContain("script-src 'self'");
  });

  it('lets plain http media through on a development machine only', async () => {
    findUnique.mockResolvedValue({
      title: 'Big night',
      status: StreamStatus.LIVE,
      host: { displayName: 'Ana' },
    });

    await controller.show(LIVE, res);
    expect(header('Content-Security-Policy')).toContain("img-src 'self' data: blob: https: http:;");

    jest.clearAllMocks();
    config.get.mockImplementation((key: string) => (key === 'NODE_ENV' ? 'production' : undefined));
    await controller.show(LIVE, res);
    expect(header('Content-Security-Policy')).toContain("img-src 'self' data: blob: https:;");
    expect(header('Content-Security-Policy')).not.toContain('http:');
  });

  it('points "Get the app" where it is configured', async () => {
    findUnique.mockResolvedValue({
      title: 'Big night',
      status: StreamStatus.LIVE,
      host: { displayName: 'Ana' },
    });
    const settings: Record<string, string> = {
      ANDROID_INSTALL_URL: 'https://example.com/mela.apk',
      IOS_INSTALL_URL: 'https://apps.apple.com/app/id1',
    };
    config.get.mockImplementation((key: string) => settings[key]);

    await controller.show(LIVE, res);

    expect(playerConfig()).toMatchObject({
      androidInstallUrl: 'https://example.com/mela.apk',
      iosInstallUrl: 'https://apps.apple.com/app/id1',
    });
  });

  it("offers Continue with Google once Firebase's web app is set, opening the policy only for its popup", async () => {
    findUnique.mockResolvedValue({
      title: 'Big night',
      status: StreamStatus.LIVE,
      host: { displayName: 'Ana' },
    });
    await controller.show(LIVE, res);
    expect(playerConfig()).not.toHaveProperty('firebase');
    expect(header('Content-Security-Policy')).not.toContain('apis.google.com');
    expect(header('Content-Security-Policy')).not.toContain('frame-src');

    jest.clearAllMocks();
    const settings: Record<string, string> = {
      NODE_ENV: 'production',
      FIREBASE_PROJECT_ID: 'mela-prod',
      FIREBASE_WEB_API_KEY: 'web-key',
      FIREBASE_WEB_APP_ID: '1:123:web:abc',
    };
    config.get.mockImplementation((key: string) => settings[key]);
    await controller.show(LIVE, res);

    expect(playerConfig().firebase).toEqual({
      apiKey: 'web-key',
      authDomain: 'mela-prod.firebaseapp.com',
      projectId: 'mela-prod',
      appId: '1:123:web:abc',
    });
    expect(header('Content-Security-Policy')).toContain(
      "script-src 'self' https://apis.google.com;",
    );
    expect(header('Content-Security-Policy')).toContain(
      'frame-src https://mela-prod.firebaseapp.com;',
    );
    expect(header('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it("keeps the player's settings from breaking out of their script tag", async () => {
    findUnique.mockResolvedValue({
      title: 'Big night',
      status: StreamStatus.LIVE,
      host: { displayName: 'Ana' },
    });
    config.get.mockImplementation((key: string) =>
      key === 'ANDROID_INSTALL_URL'
        ? 'https://x.example/</script><script>alert(1)</script>'
        : undefined,
    );

    await controller.show(LIVE, res);

    expect(page()).not.toContain('</script><script>alert(1)');
    expect(playerConfig().androidInstallUrl).toBe(
      'https://x.example/</script><script>alert(1)</script>',
    );
  });

  it('shows just the preview for a live that is over - nothing to play', async () => {
    findUnique.mockResolvedValue({
      title: 'Big night',
      status: StreamStatus.ENDED,
      host: { displayName: 'Ana' },
    });

    await controller.show(LIVE, res);

    expect(page()).toContain("Ana's live has ended");
    expect(page()).not.toContain('/web/player.js');
    expect(header('Content-Security-Policy')).toBeUndefined();
  });

  it('uses the configured app scheme', async () => {
    findUnique.mockResolvedValue(null);
    config.getOrThrow.mockImplementation(requiredSettings({ ...APP, APP_URL_SCHEME: 'mela' }));

    await controller.show(LIVE, res);

    expect(page()).toContain(`href="mela://live/${LIVE}"`);
    expect(page()).toContain('This live has ended');
  });

  it('has no built-in app identifiers: without them it serves nothing', async () => {
    findUnique.mockResolvedValue({
      title: 'Big night',
      status: StreamStatus.LIVE,
      host: { displayName: 'Ana' },
    });
    config.getOrThrow.mockImplementation(requiredSettings({ APP_URL_SCHEME: 'gamblinglive' }));

    await expect(controller.show(LIVE, res)).rejects.toThrow('ANDROID_APP_PACKAGE_NAME is not set');
    expect(send).not.toHaveBeenCalled();
  });

  it("doesn't look up an id that can't be a live", async () => {
    await controller.show('not-a-live', res);

    expect(findUnique).not.toHaveBeenCalled();
    expect(page()).toContain("This live doesn't exist or has ended.");
  });
});
