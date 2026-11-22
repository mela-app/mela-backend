import { allowedLinksFrom, hasDisallowedLink } from './link-policy';

describe('link policy', () => {
  const settings: Record<string, string> = {
    CHAT_LINK_DOMAINS: 'melaapi.example.com',
    ANDROID_APP_PACKAGE_NAME: 'com.melalive.app',
    IOS_INSTALL_URL: 'https://apps.apple.com/app/mela/id123',
  };
  const allowed = allowedLinksFrom((key) => settings[key]);

  it("lets Mela's own domain and its subdomains through", () => {
    expect(hasDisallowedLink('watch https://melaapi.example.com/live/abc', allowed)).toBe(false);
    expect(hasDisallowedLink('cdn.melaapi.example.com/x', allowed)).toBe(false);
  });

  it("lets Mela's Play Store listing through, whatever else the link carries", () => {
    expect(
      hasDisallowedLink(
        'get it: https://play.google.com/store/apps/details?id=com.melalive.app&pcampaignid=web_share',
        allowed,
      ),
    ).toBe(false);
    expect(
      hasDisallowedLink('play.google.com/store/apps/details?id=com.melalive.app', allowed),
    ).toBe(false);
  });

  it("refuses another app's listing and the rest of the Play Store", () => {
    expect(
      hasDisallowedLink('https://play.google.com/store/apps/details?id=com.scam.casino', allowed),
    ).toBe(true);
    expect(hasDisallowedLink('https://play.google.com/store/apps/dev?id=1', allowed)).toBe(true);
    expect(
      hasDisallowedLink(
        'https://play.google.com.evil.io/store/apps/details?id=com.melalive.app',
        allowed,
      ),
    ).toBe(true);
  });

  it('lets the configured install pages through, and nothing else on their sites', () => {
    expect(hasDisallowedLink('https://apps.apple.com/app/mela/id123?ref=x', allowed)).toBe(false);
    expect(hasDisallowedLink('https://apps.apple.com/app/other/id999', allowed)).toBe(true);
  });

  it('refuses other sites, and works from a plain list of domains', () => {
    expect(hasDisallowedLink('free coins at spam.example', allowed)).toBe(true);
    expect(hasDisallowedLink('https://mela.example/x', ['mela.example'])).toBe(false);
    expect(hasDisallowedLink('no links here', [])).toBe(false);
  });
});
