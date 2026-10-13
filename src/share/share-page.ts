import { ConfigService } from '@nestjs/config';

/** Where a phone without the app gets it (docs/features/share.md). */
export interface InstallLinks {
  androidPackage: string;
  // ANDROID_INSTALL_URL, or else the Play Store listing of the app's package.
  androidInstallUrl: string;
  // IOS_INSTALL_URL; none until there's an App Store listing.
  iosInstallUrl: string | null;
}

export function installLinks(config: ConfigService): InstallLinks {
  const androidPackage = config.getOrThrow<string>('ANDROID_APP_PACKAGE_NAME');
  return {
    androidPackage,
    androidInstallUrl:
      config.get<string>('ANDROID_INSTALL_URL') ||
      `https://play.google.com/store/apps/details?id=${encodeURIComponent(androidPackage)}`,
    iosInstallUrl: config.get<string>('IOS_INSTALL_URL') || null,
  };
}

export function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (char) => entities[char]);
}

// Inside a <script>, a `</script>` or `<!--` in a value would end it early.
export function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Getting Mela while it's a Google Play closed test (docs/features/share.md,
 * "Early access"): join the testers' Google Group, opt in on Play, install.
 * Null once ANDROID_TESTER_GROUP_URL is blank - Play's public listing then.
 */
export interface TesterProgram {
  groupUrl: string;
  // ANDROID_TESTER_OPT_IN_URL, or else Play's testing page for the package.
  optInUrl: string;
  storeUrl: string;
}

export function testerProgram(config: ConfigService): TesterProgram | null {
  const groupUrl = config.get<string>('ANDROID_TESTER_GROUP_URL')?.trim();
  if (!groupUrl || !/^https:\/\//i.test(groupUrl)) return null;
  const androidPackage = config.getOrThrow<string>('ANDROID_APP_PACKAGE_NAME');
  const optIn = config.get<string>('ANDROID_TESTER_OPT_IN_URL')?.trim();
  return {
    groupUrl,
    optInUrl:
      optIn && /^https:\/\//i.test(optIn)
        ? optIn
        : `https://play.google.com/apps/testing/${encodeURIComponent(androidPackage)}`,
    storeUrl: `https://play.google.com/store/apps/details?id=${encodeURIComponent(androidPackage)}`,
  };
}

/** What a share link opens in the app: `live/<id>` or `profile/<id>`. */
export type AppTarget = `${'live' | 'profile'}/${string}`;

const TARGET = /^(live|profile)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function appTarget(value: unknown): AppTarget | null {
  return typeof value === 'string' && TARGET.test(value) ? (value as AppTarget) : null;
}

/** The early-access page, coming back to [target] once installed. Absolute with an [origin]. */
export function getMelaUrl(origin: string, target: AppTarget | null): string {
  return `${origin}/get-mela${target ? `?open=${encodeURIComponent(target)}` : ''}`;
}

/**
 * Where an Android phone without Mela goes: the early-access steps while
 * Mela is a closed test, else the store. Absolute: Chrome only follows an
 * intent's fallback to a full web address.
 */
export function androidGetAppUrl(
  config: ConfigService,
  origin: string,
  target: AppTarget | null,
): string {
  return testerProgram(config)
    ? getMelaUrl(origin, target)
    : installLinks(config).androidInstallUrl;
}

/** This server's address as the browser reached it (behind the proxy: `trust proxy`). */
export function requestOrigin(req?: { protocol: string; get(name: string): string | undefined }) {
  const host = req?.get('host');
  return host ? `${req!.protocol}://${host}` : '';
}

/**
 * An app's own browser - TikTok's above all, where Mela's links arrive.
 * Opening another app from it, or signing in to Google, doesn't work there:
 * the pages say to open the link in the phone's browser first.
 */
export function inAppBrowser(userAgent: string | undefined): string | null {
  const agent = userAgent ?? '';
  if (/musical_ly|Bytedance|TikTok|trill_/i.test(agent)) return 'TikTok';
  if (/Instagram/i.test(agent)) return 'Instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(agent)) return 'Facebook';
  if (/Snapchat/i.test(agent)) return 'Snapchat';
  if (/Telegram/i.test(agent)) return 'Telegram';
  // Android's WebView inside some other app.
  if (/Android/i.test(agent) && /; wv\)/.test(agent)) return 'this app';
  return null;
}

/** An Android intent that opens [target] in Mela, or goes to [fallbackUrl]. */
export function androidIntent(
  scheme: string,
  androidPackage: string,
  target: AppTarget,
  fallbackUrl: string,
): string {
  return (
    `intent://${target}#Intent;scheme=${scheme};package=${androidPackage};` +
    `S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end`
  );
}
