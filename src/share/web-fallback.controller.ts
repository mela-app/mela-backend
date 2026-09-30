import { Controller, Get, Param, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StreamStatus } from '@prisma/client';
import { isUUID } from 'class-validator';
import type { Response } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { MELA_COLORS, MELA_LOGO_SVG } from './brand';

// Helmet's default policy would block the video SDKs' connections to their servers.
const PLAYER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** What the browser player (the mela-web repository) needs to know about this page. */
export interface PlayerConfig {
  streamId: string;
  appScheme: string;
  androidPackage: string;
  androidInstallUrl: string;
  iosInstallUrl: string | null;
}

/**
 * The browser-facing side of a share link (plan §6.12): no app installed, a
 * computer, or a crawler generating a chat-app link preview. The preview tags
 * are server-rendered here; while the live is on, the page also loads the
 * browser player (mela-web, served under /web/) over the same markup - which
 * stays as the page if the player can't load. Deliberately unversioned
 * (`VERSION_NEUTRAL`) - `/live/:id` is what goes on `https://{app-domain}/...`,
 * not `/v1/live/:id`. See docs/features/share.md.
 */
@Controller({ path: 'live', version: VERSION_NEUTRAL })
export class WebFallbackController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get(':id')
  async show(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const stream = isUUID(id)
      ? await this.prisma.stream.findUnique({
          where: { id },
          select: { title: true, status: true, host: { select: { displayName: true } } },
        })
      : null;
    const isLive = stream?.status === StreamStatus.LIVE;
    const scheme = this.config.getOrThrow<string>('APP_URL_SCHEME');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (isLive) res.setHeader('Content-Security-Policy', this.playerCsp());
    res.send(renderPage(stream, id, scheme, isLive ? this.playerConfig(id, scheme) : null));
  }

  private playerConfig(streamId: string, appScheme: string): PlayerConfig {
    const androidPackage = this.config.getOrThrow<string>('ANDROID_APP_PACKAGE_NAME');
    return {
      streamId,
      appScheme,
      androidPackage,
      androidInstallUrl:
        this.config.get<string>('ANDROID_INSTALL_URL') ||
        `https://play.google.com/store/apps/details?id=${encodeURIComponent(androidPackage)}`,
      iosInstallUrl: this.config.get<string>('IOS_INSTALL_URL') || null,
    };
  }

  // Plain http:/ws: too outside production: a LiveKit server and photos on a development machine.
  private playerCsp(): string {
    return this.config.get<string>('NODE_ENV') === 'production'
      ? PLAYER_CSP
      : PLAYER_CSP.replace("connect-src 'self' https: wss:", "connect-src 'self' https: wss: http: ws:").replace(
          "img-src 'self' data: blob: https:",
          "img-src 'self' data: blob: https: http:",
        );
  }
}

interface StreamPreview {
  title: string;
  status: StreamStatus;
  host: { displayName: string };
}

function renderPage(stream: StreamPreview | null, id: string, scheme: string, player: PlayerConfig | null): string {
  const deepLink = `${scheme}://live/${encodeURIComponent(id)}`;
  const isLive = stream?.status === StreamStatus.LIVE;
  const title = stream ? escapeHtml(stream.title) : 'This live has ended';
  const description = stream
    ? isLive
      ? `${escapeHtml(stream.host.displayName)} is live now on Mela`
      : `${escapeHtml(stream.host.displayName)}'s live has ended - check out their profile`
    : "This live doesn't exist or has ended.";
  const playerTags = player
    ? `
<link rel="stylesheet" href="/web/player.css" />
<script id="mela-player-config" type="application/json">${jsonForHtml(player)}</script>
<script type="module" src="/web/player.js"></script>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${title} - Mela</title>
<meta name="theme-color" content="#0E0E14" />
<meta property="og:site_name" content="Mela" />
<meta property="og:type" content="video.other" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta name="description" content="${description}" />
<style>
:root { color-scheme: dark; }
html, body { margin: 0; background: #0e0e14; color: #f5f5f7; font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
.fallback { min-height: 100vh; display: grid; place-items: center; }
.fallback main { width: min(100% - 48px, 420px); padding: 48px 0; text-align: center; }
.fallback .logo svg { height: 56px; width: auto; }
.fallback .live { display: inline-block; margin-top: 32px; padding: 2px 10px; border-radius: 999px; background: #ff3b5c; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; }
.fallback h1 { margin: 16px 0 8px; font-size: 24px; line-height: 1.3; overflow-wrap: anywhere; }
.fallback p { margin: 0; color: #9c9cac; }
.fallback .open { display: block; margin-top: 32px; padding: 14px 20px; border-radius: 999px; background: ${MELA_COLORS.teal}; color: #fff; font-weight: 700; text-decoration: none; }
</style>${playerTags}
</head>
<body>
<div id="mela-player">
<div class="fallback">
<main>
<div class="logo">${MELA_LOGO_SVG}</div>
${isLive ? '<div class="live">LIVE</div>' : ''}
<h1>${title}</h1>
<p>${description}</p>
<a class="open" href="${deepLink}">Open in Mela</a>
</main>
</div>
</div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, (char) => entities[char]);
}

// Inside a <script>, a `</script>` or `<!--` in a value would end it early.
function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
