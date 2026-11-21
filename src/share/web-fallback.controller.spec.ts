import { ConfigService } from '@nestjs/config';
import { StreamStatus, StreamVisibility } from '@prisma/client';
import type { Request, Response } from 'express';
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
      visibility: StreamVisibility.PUBLIC,
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
      visibility: StreamVisibility.PUBLIC,
      host: { displayName: 'Ana' },
    });

    await controller.show(LIVE, res);

    expect(page()).toContain('<script type="module" src="/web/player.js"></script>');
    expect(page()).toContain('<link rel="stylesheet" href="/web/player.css" />');
    expect(playerConfig()).toEqual({
      streamId: LIVE,
      appScheme: 'gamblinglive',
      androidPackage: 'com.gamblinglive.app',
      // Play hands the referrer to a fresh install, which opens this live.
      androidInstallUrl: `https://play.google.com/store/apps/details?id=com.gamblinglive.app&referrer=${encodeURIComponent(`mela_open=live/${LIVE}`)}`,
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
      visibility: StreamVisibility.PUBLIC,
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
      visibility: StreamVisibility.PUBLIC,
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
      visibility: StreamVisibility.PUBLIC,
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
      visibility: StreamVisibility.PUBLIC,
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

  it("previews a running live with its latest frame, escaped; an ended one's isn't shown", async () => {
    findUnique.mockResolvedValue({
      title: 'Big night',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      thumbnailUrl: 'https://media.example.com/thumbnails/a.jpg?x=1&y="2"',
      host: { displayName: 'Ana' },
    });
    await controller.show(LIVE, res);
    expect(page()).toContain(
      '<meta property="og:image" content="https://media.example.com/thumbnails/a.jpg?x=1&amp;y=&quot;2&quot;" />',
    );
    expect(page()).toContain('<meta name="twitter:card" content="summary_large_image" />');

    send.mockClear();
    findUnique.mockResolvedValue({
      title: 'Big night',
      status: StreamStatus.ENDED,
      thumbnailUrl: 'https://media.example.com/thumbnails/a.jpg',
      host: { displayName: 'Ana' },
    });
    await controller.show(LIVE, res);
    expect(page()).not.toContain('og:image');
  });

  it("keeps a followers' or friends' live private in a browser: no title, no player, the app instead", async () => {
    findUnique.mockResolvedValue({
      title: 'Secret plans',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.FRIENDS,
      thumbnailUrl: 'https://media.example.com/thumbnails/a.jpg',
      host: { displayName: 'Ana' },
    });

    await controller.show(LIVE, res);

    expect(page()).toContain('<title>A private live - Mela</title>');
    expect(page()).toContain('Ana is live for their friends - open it in the app to watch.');
    expect(page()).not.toContain('Secret plans');
    expect(page()).not.toContain('mela-player-config');
    expect(page()).not.toContain('og:image');
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
      visibility: StreamVisibility.PUBLIC,
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

  describe('early access (docs/features/share.md)', () => {
    const request = (agent: string) =>
      ({
        protocol: 'https',
        get: (name: string) => ({ host: 'melalive.app', 'user-agent': agent })[name.toLowerCase()],
      }) as unknown as Request;
    const getMela = `https://melalive.app/get-mela?open=${encodeURIComponent(`live/${LIVE}`)}`;
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile Safari/537.36';

    beforeEach(() => {
      config.get.mockImplementation((key: string) =>
        key === 'ANDROID_TESTER_GROUP_URL' ? 'https://groups.google.com/g/mela-tester' : undefined,
      );
      findUnique.mockResolvedValue({
        title: 'Big night',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
        host: { displayName: 'Ana' },
      });
    });

    it("the player's Get the app, and Open in Mela without the app, go to the tester steps for this live", async () => {
      await controller.show(LIVE, res, request(android));

      expect(playerConfig().androidInstallUrl).toBe(getMela);
      expect(page()).toContain(
        `href="intent://live/${LIVE}#Intent;scheme=gamblinglive;package=com.gamblinglive.app;` +
          `S.browser_fallback_url=${encodeURIComponent(getMela)};end">Open in Mela`,
      );
      expect(page()).toContain(`href="${getMela}">New to Mela? Get it here`);
    });

    it("from TikTok's browser, Open in Mela goes straight to the steps - it can't open apps", async () => {
      await controller.show(
        LIVE,
        res,
        request(
          `${android.replace('Pixel 8', 'Pixel 8; wv')} musical_ly_36.0.4 BytedanceWebview/d8a21c6`,
        ),
      );

      expect(page()).toContain(`href="${getMela}">Open in Mela`);
    });
  });

  describe('computers and iPhones, which cannot open the Android app', () => {
    const request = (agent: string) =>
      ({
        protocol: 'https',
        get: (name: string) => ({ host: 'melalive.app', 'user-agent': agent })[name.toLowerCase()],
      }) as unknown as Request;
    const windows =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
    const live = {
      title: 'Big night',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      host: { displayName: 'Ana' },
    };

    it('a computer gets the player, and - if it cannot load - try again and Mela for Android, no app link', async () => {
      findUnique.mockResolvedValue(live);

      await controller.show(LIVE, res, request(windows));

      expect(page()).toContain('/web/player.js');
      expect(page()).not.toContain('gamblinglive://');
      expect(page()).not.toContain('intent://');
      expect(page()).toContain('>Try again</a>');
      expect(page()).toContain(
        `play.google.com/store/apps/details?id=com.gamblinglive.app&amp;referrer=mela_open%3Dlive%2F${LIVE}`,
      );
      expect(page()).toContain('Get Mela for Android');
    });

    it('an ended live on a computer just offers Mela for Android', async () => {
      findUnique.mockResolvedValue({ ...live, status: StreamStatus.ENDED });

      await controller.show(LIVE, res, request(windows));

      expect(page()).not.toContain('Try again');
      expect(page()).toContain('Get Mela for Android');
    });

    it('an iPhone without an App Store listing gets no app link', async () => {
      findUnique.mockResolvedValue(live);

      await controller.show(LIVE, res, request(iphone));

      expect(page()).not.toContain('gamblinglive://');
      expect(page()).toContain('Get Mela for Android');
    });
  });
});
