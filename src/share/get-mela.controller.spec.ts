import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { GetMelaController } from './get-mela.controller';
import { inAppBrowser } from './share-page';

const LIVE = '3f1c9a52-7c2e-4a8b-9d7e-2b6f0c1d4e5a';
const GROUP = 'https://groups.google.com/g/mela-tester';
const CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const TIKTOK =
  'Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 trill_360004 musical_ly_36.0.4 BytedanceWebview/d8a21c6';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('GetMelaController', () => {
  let settings: Record<string, string>;
  const config = {
    get: (key: string) => settings[key],
    getOrThrow: (key: string) => {
      if (!settings[key]) throw new Error(`${key} is not set`);
      return settings[key];
    },
  };
  const send = jest.fn();
  const setHeader = jest.fn();
  const redirect = jest.fn();
  const res = { send, setHeader, redirect } as unknown as Response;
  const req = (agent: string) =>
    ({
      protocol: 'https',
      get: (name: string) => ({ host: 'melalive.app', 'user-agent': agent })[name.toLowerCase()],
    }) as unknown as Request;
  const controller = new GetMelaController(config as unknown as ConfigService);
  const page = () => send.mock.calls[0][0] as string;

  beforeEach(() => {
    jest.clearAllMocks();
    settings = {
      APP_URL_SCHEME: 'melalive',
      ANDROID_APP_PACKAGE_NAME: 'com.melalive.app',
      ANDROID_TESTER_GROUP_URL: GROUP,
    };
  });

  it('walks a phone without Mela through the closed test, then back to the shared live', () => {
    controller.show(`live/${LIVE}`, req(CHROME), res);

    expect(page()).toContain(`href="${GROUP}"`);
    expect(page()).toContain('href="https://play.google.com/apps/testing/com.melalive.app"');
    expect(page()).toContain(
      'href="https://play.google.com/store/apps/details?id=com.melalive.app"',
    );
    // Opens the live in Mela - or, not installed yet, comes back here.
    expect(page()).toContain(
      `href="intent://live/${LIVE}#Intent;scheme=melalive;package=com.melalive.app;` +
        `S.browser_fallback_url=${encodeURIComponent(`https://melalive.app/get-mela?open=${encodeURIComponent(`live/${LIVE}`)}`)};end"`,
    );
    expect(page()).toContain('Open the live in Mela');
    expect(page()).toContain(`href="/live/${LIVE}"`);
    expect(page()).not.toContain('First, open this page in your browser');
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      expect.stringContaining("script-src 'nonce-"),
    );
  });

  it("first sends someone in TikTok's browser to their phone's browser", () => {
    controller.show(`live/${LIVE}`, req(TIKTOK), res);

    expect(page()).toContain('First, open this page in your browser');
    expect(page()).toContain("TikTok's browser can't sign you in to Google or open Mela.");
    expect(page()).toContain(
      'href="intent://melalive.app/get-mela?open=' +
        encodeURIComponent(`live/${LIVE}`) +
        '#Intent;scheme=https;package=com.android.chrome;end"',
    );
    expect(page()).toContain('Copy link');
  });

  it('tells an iPhone the app is Android-only for now, and offers the live in the browser', () => {
    controller.show(`live/${LIVE}`, req(IPHONE), res);

    expect(page()).toContain('Mela is on Android for now');
    expect(page()).toContain(`href="/live/${LIVE}"`);
  });

  it('ignores anything but a live or profile to come back to', () => {
    controller.show('javascript:alert(1)', req(CHROME), res);

    expect(page()).not.toContain('javascript:');
    expect(page()).toContain('Open Mela');
    expect(page()).not.toContain('/live/');
  });

  it('uses the opt-in link set, and goes to the store once Mela is public', () => {
    settings.ANDROID_TESTER_OPT_IN_URL = 'https://play.google.com/apps/internaltest/123';
    controller.show(undefined, req(CHROME), res);
    expect(page()).toContain('href="https://play.google.com/apps/internaltest/123"');

    jest.clearAllMocks();
    delete settings.ANDROID_TESTER_GROUP_URL;
    controller.show(`live/${LIVE}`, req(CHROME), res);
    expect(redirect).toHaveBeenCalledWith(
      302,
      'https://play.google.com/store/apps/details?id=com.melalive.app',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("knows the apps' own browsers, and not Chrome or Safari", () => {
    expect(inAppBrowser(TIKTOK)).toBe('TikTok');
    expect(inAppBrowser(`${CHROME} Instagram 300.0`)).toBe('Instagram');
    expect(inAppBrowser(`${CHROME} [FBAN/FB4A;FBAV/450.0]`)).toBe('Facebook');
    expect(inAppBrowser(CHROME)).toBeNull();
    expect(inAppBrowser(IPHONE)).toBeNull();
    expect(inAppBrowser(undefined)).toBeNull();
  });
});
