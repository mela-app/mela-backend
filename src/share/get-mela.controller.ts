import { Controller, Get, Query, Req, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import { MELA_COLORS, MELA_LOGO_SVG } from './brand';
import {
  androidIntent,
  AppTarget,
  appTarget,
  escapeHtml,
  getMelaUrl,
  inAppBrowser,
  installLinks,
  jsonForHtml,
  withInstallReferrer,
  requestOrigin,
  TesterProgram,
  testerProgram,
} from './share-page';

/** What the page's script needs. */
interface GetMelaScriptConfig {
  // Steps already done are remembered on this phone.
  storageKey: string;
  link: string;
}

/**
 * `/get-mela[?open=live/<id>|profile/<id>]` - getting Mela while it's a
 * Google Play closed test (docs/features/share.md, "Early access"): join
 * the testers' Google Group, opt in on Play, install, then back to the live
 * or profile that was shared. Opened from TikTok (or another app's
 * browser), it first says to open the link in the phone's browser - Google
 * sign-in and opening apps don't work in there. Once Mela is public
 * (ANDROID_TESTER_GROUP_URL blank), it sends phones to the store instead.
 */
@Controller({ path: 'get-mela', version: VERSION_NEUTRAL })
export class GetMelaController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  show(@Query('open') open: unknown, @Req() req: Request, @Res() res: Response): void {
    const target = appTarget(open);
    const program = testerProgram(this.config);
    const links = installLinks(this.config);
    if (!program) {
      res.redirect(302, links.androidInstallUrl);
      return;
    }
    const origin = requestOrigin(req);
    const scheme = this.config.getOrThrow<string>('APP_URL_SCHEME');
    const self = getMelaUrl(origin, target);
    const nonce = randomBytes(16).toString('base64');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', csp(nonce));
    res.send(
      renderGetMela({
        program,
        target,
        // Back here if Mela isn't installed yet.
        openApp: target
          ? androidIntent(scheme, links.androidPackage, target, self)
          : `intent://#Intent;scheme=${scheme};package=${links.androidPackage};S.browser_fallback_url=${encodeURIComponent(self)};end`,
        inApp: inAppBrowser(req.get('user-agent')),
        iPhone: /iPhone|iPad|iPod/i.test(req.get('user-agent') ?? ''),
        self,
        nonce,
      }),
    );
  }
}

function csp(nonce: string): string {
  return [
    "default-src 'none'",
    'img-src data:',
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

interface PageInput {
  program: TesterProgram;
  target: AppTarget | null;
  openApp: string;
  inApp: string | null;
  iPhone: boolean;
  self: string;
  nonce: string;
}

export function renderGetMela(input: PageInput): string {
  const { program, target, inApp, self, nonce } = input;
  const what = target?.startsWith('live/') ? 'the live' : target ? 'the profile' : 'Mela';
  const back = target?.startsWith('live/')
    ? `<a class="quiet" href="/${escapeHtml(target)}">Watch the live in this browser meanwhile</a>`
    : '';
  // Chrome, from another app's browser - works where that browser lets an app open.
  const chrome = self.startsWith('http')
    ? `intent://${self.replace(/^https?:\/\//, '')}#Intent;scheme=${self.startsWith('https') ? 'https' : 'http'};package=com.android.chrome;end`
    : null;

  const inAppNotice = inApp
    ? `
<section class="notice" id="in-app">
<h2>First, open this page in your browser</h2>
<p>${escapeHtml(inApp)}'s browser can't sign you in to Google or open Mela.</p>
<ol class="how">
<li>Tap <strong>⋯</strong> (or <strong>⋮</strong>) at the top right</li>
<li>Choose <strong>Open in browser</strong></li>
</ol>
${chrome ? `<a class="button" href="${escapeHtml(chrome)}">Open in Chrome</a>` : ''}
<button class="button" type="button" id="copy">Copy link</button>
<p class="small" id="copied" hidden>Copied - paste it in Chrome.</p>
</section>`
    : '';

  const iPhoneNotice = input.iPhone
    ? `
<section class="notice">
<h2>Mela is on Android for now</h2>
<p>The iPhone app is coming. ${back ? 'You can watch the live in this browser.' : ''}</p>
${back}
</section>`
    : '';

  const step = (n: number, id: string, title: string, text: string, action: string) => `
<li class="step" id="${id}">
<span class="num" aria-hidden="true">${n}</span>
<div>
<h3>${title} <span class="done" hidden>✓ Done</span></h3>
<p>${text}</p>
${action}
</div>
</li>`;

  const body = `
<h1>Get Mela</h1>
<p class="lead">Mela is in early access on Google Play. It takes a minute: three steps, then you're in${
    target ? ` - and on ${what}` : ''
  }.</p>
${inAppNotice}${iPhoneNotice}
<ol class="steps">
${step(
  1,
  'group',
  'Join the Mela testers',
  'Sign in with the Google account you use on Google Play, then tap <strong>Join group</strong>.',
  `<a class="button primary" data-step="group" href="${escapeHtml(program.groupUrl)}" target="_blank" rel="noopener">Join the group</a>`,
)}
${step(
  2,
  'optin',
  'Become a tester',
  'On the page that opens, tap <strong>Become a tester</strong>. Same Google account as step 1.',
  `<a class="button primary" data-step="optin" href="${escapeHtml(program.optInUrl)}" target="_blank" rel="noopener">Become a tester</a>`,
)}
${step(
  3,
  'install',
  'Install Mela',
  target
    ? `Install it from Google Play, then tap <strong>Open</strong> there - once you've signed up, you're on ${what}. If Play says it isn't available yet, wait a few minutes after step 2 and try again.`
    : "Install it from Google Play. If Play says it isn't available yet, wait a few minutes after step 2 and try again.",
  `<a class="button primary" data-step="install" href="${escapeHtml(withInstallReferrer(program.storeUrl, target))}" target="_blank" rel="noopener">Install from Google Play</a>`,
)}
${step(
  4,
  'open',
  target ? `Open ${what}` : 'Open Mela',
  target
    ? `Not on ${what} after signing up? Come back to this page and tap the button.`
    : 'Sign up in the app and you are in.',
  `<a class="button primary" data-step="open" href="${escapeHtml(input.openApp)}">${
    target ? `Open ${what} in Mela` : 'Open Mela'
  }</a>`,
)}
</ol>
${input.iPhone ? '' : back}
<p class="small">Already have Mela? Tap step 4.</p>`;

  const script: GetMelaScriptConfig = { storageKey: 'mela.get-mela.steps', link: self };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>Get Mela</title>
<meta name="theme-color" content="#0E0E14" />
<meta property="og:site_name" content="Mela" />
<meta property="og:title" content="Get Mela" />
<meta property="og:description" content="Join Mela's early access on Google Play" />
<style>
:root { color-scheme: dark; }
html, body { margin: 0; background: #0e0e14; color: #f5f5f7; font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
main { width: min(100% - 32px, 460px); margin: 0 auto; padding: 32px 0 48px; }
.logo { text-align: center; }
.logo svg { height: 44px; width: auto; }
h1 { margin: 20px 0 4px; font-size: 26px; text-align: center; }
h2 { margin: 0 0 6px; font-size: 18px; }
h3 { margin: 0 0 4px; font-size: 16px; }
p { margin: 0; color: #9c9cac; }
.lead { text-align: center; }
.small { margin-top: 16px; font-size: 13px; text-align: center; }
.notice { margin-top: 24px; padding: 16px; border-radius: 16px; background: #2d2414; border: 1px solid #f5a623; }
.notice p, .how { color: #f5f5f7; }
.how { margin: 8px 0 0; padding-left: 20px; }
.steps { list-style: none; margin: 24px 0 0; padding: 0; }
.step { display: flex; gap: 14px; margin-top: 12px; padding: 16px; border-radius: 16px; background: #191922; }
.step.is-done { opacity: 0.7; }
.num { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: ${MELA_COLORS.teal}; color: #fff; font-weight: 800; }
.step > div { flex: 1; min-width: 0; }
.done { color: #22c55e; font-size: 13px; font-weight: 700; }
.button { display: block; width: 100%; box-sizing: border-box; margin-top: 12px; padding: 12px 18px; border: 0; border-radius: 999px; background: #2d2d3d; color: #f5f5f7; font: inherit; font-weight: 700; text-align: center; text-decoration: none; cursor: pointer; }
.primary { background: ${MELA_COLORS.teal}; color: #fff; }
.quiet { display: block; margin-top: 20px; color: #7cc4e8; text-align: center; }
</style>
</head>
<body>
<main>
<div class="logo">${MELA_LOGO_SVG}</div>${body}
</main>
<script id="mela-get" type="application/json">${jsonForHtml(script)}</script>
<script nonce="${nonce}">${STEPS_SCRIPT}</script>
</body>
</html>`;
}

// Ticks the steps tapped before (this phone only), and copies the link.
const STEPS_SCRIPT = `(function () {
  var config = JSON.parse(document.getElementById('mela-get').textContent);
  var done = {};
  try { done = JSON.parse(localStorage.getItem(config.storageKey) || '{}') || {}; } catch (e) {}
  function mark(step) {
    var item = document.getElementById(step);
    if (!item) return;
    item.classList.add('is-done');
    var badge = item.querySelector('.done');
    if (badge) badge.hidden = false;
  }
  Object.keys(done).forEach(mark);
  document.querySelectorAll('[data-step]').forEach(function (link) {
    link.addEventListener('click', function () {
      var step = link.getAttribute('data-step');
      if (step === 'open') return;
      done[step] = true;
      try { localStorage.setItem(config.storageKey, JSON.stringify(done)); } catch (e) {}
      mark(step);
    });
  });
  var copy = document.getElementById('copy');
  if (copy) copy.addEventListener('click', function () {
    var shown = function () { document.getElementById('copied').hidden = false; };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(config.link).then(shown, function () { window.prompt('Copy this link', config.link); });
    } else {
      window.prompt('Copy this link', config.link);
    }
  });
})();`;
