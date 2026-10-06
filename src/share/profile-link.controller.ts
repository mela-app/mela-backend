import { Controller, Get, Param, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import { isUUID } from 'class-validator';
import { randomBytes } from 'crypto';
import type { Response } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { MELA_COLORS, MELA_LOGO_SVG } from './brand';
import { escapeHtml, InstallLinks, installLinks, jsonForHtml } from './share-page';

/** How the page's script sends a phone on - into the app, or to its store. */
export interface ProfileOpenConfig {
  // Opens the app, or else Chrome follows the intent's fallback to the store.
  androidIntent: string;
  // Only once Universal Links open the app before this page ever loads (APPLE_APP_ID).
  iosStoreUrl: string | null;
}

interface SharedProfile {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Where a shared profile's link lands, `/profile/:id` (docs/features/share.md).
 * A phone with Mela opens the profile in the app; one without goes to the
 * store for its platform; a computer, or a chat app building a link
 * preview, gets the page. Who may share a profile is the owner's choice,
 * enforced where the app gets the link (`canShare`); the page shows only
 * what is public anyway - name, username and picture. Unversioned, like `/live/:id`.
 */
@Controller({ path: 'profile', version: VERSION_NEUTRAL })
export class ProfileLinkController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get(':id')
  async show(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const user = isUUID(id)
      ? await this.prisma.user.findUnique({
          where: { id },
          select: { username: true, displayName: true, avatarUrl: true, status: true },
        })
      : null;
    const profile = user?.status === UserStatus.ACTIVE ? user : null;
    const links = installLinks(this.config);
    const nonce = randomBytes(16).toString('base64');

    res.status(profile ? 200 : 404);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', this.csp(nonce));
    res.send(
      profile
        ? renderProfile(profile, this.openConfig(id, links), links, this.deepLink(id), nonce)
        : renderUnavailable(links),
    );
  }

  private deepLink(userId: string): string {
    return `${this.config.getOrThrow<string>('APP_URL_SCHEME')}://profile/${encodeURIComponent(userId)}`;
  }

  private openConfig(userId: string, links: InstallLinks): ProfileOpenConfig {
    const scheme = this.config.getOrThrow<string>('APP_URL_SCHEME');
    const androidIntent =
      `intent://profile/${encodeURIComponent(userId)}#Intent;scheme=${scheme};` +
      `package=${links.androidPackage};` +
      `S.browser_fallback_url=${encodeURIComponent(links.androidInstallUrl)};end`;
    const universalLinks = Boolean(this.config.get<string>('APPLE_APP_ID'));
    return { androidIntent, iosStoreUrl: universalLinks ? links.iosInstallUrl : null };
  }

  // Pictures over plain http too outside production: S3Mock on a development machine.
  private csp(nonce: string): string {
    const images =
      this.config.get<string>('NODE_ENV') === 'production' ? 'https: data:' : 'https: http: data:';
    return [
      "default-src 'none'",
      `img-src ${images}`,
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
}

// Runs once the page is parsed: a phone goes straight on; a computer stays on the page.
const OPEN_SCRIPT = `(function () {
  var config = JSON.parse(document.getElementById('mela-open').textContent);
  var agent = navigator.userAgent;
  var ios = /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
  if (/Android/.test(agent)) {
    document.getElementById('open').href = config.androidIntent;
    location.replace(config.androidIntent);
  } else if (ios && config.iosStoreUrl) {
    location.replace(config.iosStoreUrl);
  }
})();`;

function renderProfile(
  profile: SharedProfile,
  open: ProfileOpenConfig,
  links: InstallLinks,
  deepLink: string,
  nonce: string,
): string {
  const name = escapeHtml(profile.displayName);
  const username = escapeHtml(profile.username);
  const picture = webImage(profile.avatarUrl);
  const avatar = picture
    ? `<img class="avatar" src="${escapeHtml(picture)}" alt="" width="96" height="96" />`
    : `<div class="avatar initial" aria-hidden="true">${escapeHtml(initialOf(profile.displayName))}</div>`;
  const head = `
<meta property="og:type" content="profile" />
<meta property="og:title" content="${name} (@${username})" />
<meta property="og:description" content="Follow ${name} on Mela" />
<meta property="profile:username" content="${username}" />
${picture ? `<meta property="og:image" content="${escapeHtml(picture)}" />` : ''}
<meta name="twitter:card" content="summary" />
<meta name="description" content="Follow ${name} on Mela" />`;
  const body = `
${avatar}
<h1>${name}</h1>
<p>@${username} on Mela</p>
<a id="open" class="button primary" href="${escapeHtml(deepLink)}">Open in the Mela app</a>
${storeButtons(links)}`;
  const scripts = `
<script id="mela-open" type="application/json">${jsonForHtml(open)}</script>
<script nonce="${nonce}">${OPEN_SCRIPT}</script>`;
  return page(`${name} (@${username}) - Mela`, head, body, scripts);
}

function renderUnavailable(links: InstallLinks): string {
  const body = `
<h1>This profile isn't available</h1>
<p>The link may be wrong, or the account is no longer on Mela.</p>
${storeButtons(links)}`;
  return page("This profile isn't available - Mela", '', body, '');
}

function storeButtons(links: InstallLinks): string {
  const android = `<a class="button" href="${escapeHtml(links.androidInstallUrl)}">Get Mela for Android</a>`;
  const ios = links.iosInstallUrl
    ? `<a class="button" href="${escapeHtml(links.iosInstallUrl)}">Get Mela for iPhone</a>`
    : '';
  return `<div class="stores">${android}${ios}</div>`;
}

function page(title: string, head: string, body: string, scripts: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<meta name="theme-color" content="#0E0E14" />
<meta property="og:site_name" content="Mela" />${head}
<style>
:root { color-scheme: dark; }
html, body { margin: 0; background: #0e0e14; color: #f5f5f7; font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
body { min-height: 100vh; display: grid; place-items: center; }
main { width: min(100% - 48px, 420px); padding: 48px 0; text-align: center; }
.logo svg { height: 48px; width: auto; }
.avatar { display: block; margin: 32px auto 0; width: 96px; height: 96px; border-radius: 50%; object-fit: cover; background: #191922; }
.initial { display: grid; place-items: center; font-size: 40px; font-weight: 800; color: #fff; background: ${MELA_COLORS.teal}; }
h1 { margin: 16px 0 4px; font-size: 24px; line-height: 1.3; overflow-wrap: anywhere; }
p { margin: 0; color: #9c9cac; overflow-wrap: anywhere; }
.button { display: block; margin-top: 12px; padding: 14px 20px; border-radius: 999px; background: #191922; color: #f5f5f7; font-weight: 700; text-decoration: none; }
.primary { margin-top: 32px; background: ${MELA_COLORS.teal}; color: #fff; }
.stores { margin-top: 24px; }
</style>
</head>
<body>
<main>
<div class="logo">${MELA_LOGO_SVG}</div>${body}
</main>${scripts}
</body>
</html>`;
}

// Only a real web address goes into an <img> or a preview.
function webImage(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}
