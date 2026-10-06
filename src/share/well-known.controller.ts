import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Android App Links / iOS Universal Links domain-verification files (plan
 * §6.12). Empty/placeholder until a real app domain and a signed app exist
 * (needed from the project owner, same as the Agora keys) - the route
 * exists and is wired up now so nothing else has to change once real
 * values are set, only the env vars below.
 */
@Controller({ path: '.well-known', version: VERSION_NEUTRAL })
export class WellKnownController {
  constructor(private readonly config: ConfigService) {}

  @Get('assetlinks.json')
  assetLinks() {
    const fingerprint = this.config.get<string>('ANDROID_APP_SHA256_FINGERPRINT');
    if (!fingerprint) return [];
    const packageName = this.config.getOrThrow<string>('ANDROID_APP_PACKAGE_NAME');
    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: packageName,
          sha256_cert_fingerprints: [fingerprint],
        },
      },
    ];
  }

  @Get('apple-app-site-association')
  appleAppSiteAssociation() {
    const appId = this.config.get<string>('APPLE_APP_ID');
    if (!appId) return { applinks: { apps: [], details: [] } };
    return {
      applinks: { apps: [], details: [{ appID: appId, paths: ['/live/*', '/profile/*'] }] },
    };
  }
}
