import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import type { Response } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileLinkController, ProfileOpenConfig } from './profile-link.controller';

const USER = '8d2f6c3e-1b4a-4e7d-9c5b-3a2e1f0d4c6b';

describe('ProfileLinkController', () => {
  const findUnique = jest.fn();
  const prisma = { user: { findUnique } };
  const config = { get: jest.fn(), getOrThrow: jest.fn() };
  const send = jest.fn();
  const setHeader = jest.fn();
  const status = jest.fn();
  const res = { send, setHeader, status } as unknown as Response;
  const controller = new ProfileLinkController(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
  );
  const page = () => send.mock.calls[0][0] as string;
  const header = (name: string) =>
    setHeader.mock.calls.find(([key]) => key === name)?.[1] as string | undefined;
  const openConfig = (): ProfileOpenConfig | null => {
    const json = /<script id="mela-open" type="application\/json">(.*?)<\/script>/.exec(
      page(),
    )?.[1];
    return json ? (JSON.parse(json) as ProfileOpenConfig) : null;
  };
  const settings = (values: Record<string, string>) => {
    const all: Record<string, string> = {
      APP_URL_SCHEME: 'melalive',
      ANDROID_APP_PACKAGE_NAME: 'com.melalive.app',
      ...values,
    };
    config.get.mockImplementation((key: string) => all[key]);
    config.getOrThrow.mockImplementation((key: string) => {
      if (!all[key]) throw new Error(`${key} is not set`);
      return all[key];
    });
  };
  const ana = {
    username: 'ana',
    displayName: 'Ana & "Co"',
    avatarUrl: 'https://media.example.com/avatars/ana.jpg',
    status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    settings({});
  });

  it('previews the profile with only what is public, escaping what users wrote', async () => {
    findUnique.mockResolvedValue(ana);

    await controller.show(USER, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: USER },
      select: { username: true, displayName: true, avatarUrl: true, status: true },
    });
    expect(page()).toContain('<title>Ana &amp; &quot;Co&quot; (@ana) - Mela</title>');
    expect(page()).toContain(
      '<meta property="og:title" content="Ana &amp; &quot;Co&quot; (@ana)" />',
    );
    expect(page()).toContain(
      '<meta property="og:image" content="https://media.example.com/avatars/ana.jpg" />',
    );
    expect(page()).toContain('<meta name="robots" content="noindex" />');
    expect(page()).not.toContain('"Co"');
  });

  it('opens the profile in the app, or sends Android to the store', async () => {
    findUnique.mockResolvedValue(ana);

    await controller.show(USER, res);

    expect(page()).toContain(`href="melalive://profile/${USER}"`);
    expect(openConfig()).toEqual({
      androidIntent:
        `intent://profile/${USER}#Intent;scheme=melalive;package=com.melalive.app;` +
        'S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.melalive.app;end',
      iosStoreUrl: null,
    });
    expect(page()).toContain(
      'href="https://play.google.com/store/apps/details?id=com.melalive.app">Get Mela for Android',
    );
    expect(page()).not.toContain('Get Mela for iPhone');
  });

  it('uses the configured install links', async () => {
    settings({
      ANDROID_INSTALL_URL: 'https://downloads.example.com/mela.apk',
      IOS_INSTALL_URL: 'https://apps.apple.com/app/id123',
    });
    findUnique.mockResolvedValue(ana);

    await controller.show(USER, res);

    expect(openConfig()?.androidIntent).toContain(
      'S.browser_fallback_url=https%3A%2F%2Fdownloads.example.com%2Fmela.apk;end',
    );
    expect(page()).toContain('href="https://apps.apple.com/app/id123">Get Mela for iPhone');
    // Without Universal Links an iPhone with the app would land here too: it isn't sent away.
    expect(openConfig()?.iosStoreUrl).toBeNull();
  });

  it('sends an iPhone to the App Store once Universal Links open the app first', async () => {
    settings({
      APPLE_APP_ID: 'TEAM.com.melalive.app',
      IOS_INSTALL_URL: 'https://apps.apple.com/app/id123',
    });
    findUnique.mockResolvedValue(ana);

    await controller.show(USER, res);

    expect(openConfig()?.iosStoreUrl).toBe('https://apps.apple.com/app/id123');
  });

  it("runs only its own script, after the page's buttons", async () => {
    findUnique.mockResolvedValue(ana);

    await controller.show(USER, res);

    const nonce = /script-src 'nonce-([^']+)'/.exec(header('Content-Security-Policy') ?? '')?.[1];
    expect(nonce).toBeTruthy();
    expect(page()).toContain(`<script nonce="${nonce}">`);
    expect(page().indexOf('<script nonce=')).toBeGreaterThan(page().indexOf('id="open"'));
    expect(header('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('shows initials, never a picture that is not a web address', async () => {
    findUnique.mockResolvedValue({
      ...ana,
      displayName: 'abebe',
      avatarUrl: 'javascript:alert(1)',
    });

    await controller.show(USER, res);

    expect(page()).not.toContain('javascript:');
    expect(page()).not.toContain('og:image');
    expect(page()).toContain('<div class="avatar initial" aria-hidden="true">A</div>');
  });

  it.each([
    ['an unknown account', USER, null],
    ['a suspended account', USER, { ...ana, status: UserStatus.SUSPENDED }],
    ['an id that is not one', 'not-a-uuid', null],
  ])('says %s is not available, without opening anything', async (_, id, row) => {
    findUnique.mockResolvedValue(row);

    await controller.show(id, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(page()).toContain("This profile isn't available");
    expect(page()).not.toContain('<script');
    expect(page()).toContain('Get Mela for Android');
    if (id === 'not-a-uuid') expect(findUnique).not.toHaveBeenCalled();
  });
});
