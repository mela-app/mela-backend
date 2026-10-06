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
