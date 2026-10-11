import { ConfigService } from '@nestjs/config';
import { AppPlatform } from '@prisma/client';
import { installLinks } from '../share/share-page';

/**
 * Where a phone gets an update: Mela's Google Play listing (or
 * ANDROID_INSTALL_URL), and IOS_INSTALL_URL for the App Store - null until
 * there's a listing. Releases don't carry their own link any more; the
 * store has every version.
 */
export function storeLink(config: ConfigService, platform: AppPlatform): string | null {
  const links = installLinks(config);
  return platform === AppPlatform.IOS ? links.iosInstallUrl : links.androidInstallUrl;
}
