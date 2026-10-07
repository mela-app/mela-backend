import { Controller, Get, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { MELA_COLORS, MELA_LOGO_SVG } from './brand';
import { escapeHtml } from './share-page';

/**
 * `/delete-account` - how to delete a Mela account, what goes and what stays
 * (docs/features/auth.md). Google Play asks for this web page in the app's
 * Data safety form, for people who no longer have the app; without the app,
 * they write to SUPPORT_EMAIL and a super admin deletes the account from the
 * console. Static: no script, no cookies.
 */
@Controller({ path: 'delete-account', version: VERSION_NEUTRAL })
export class AccountDeletionPageController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  show(@Res() res: Response): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.send(renderAccountDeletionPage(this.config.get<string>('SUPPORT_EMAIL')?.trim() || null));
  }
}

export function renderAccountDeletionPage(supportEmail: string | null): string {
  const withoutApp = supportEmail
    ? `<p>Email <a href="mailto:${escapeHtml(supportEmail)}?subject=${encodeURIComponent('Delete my Mela account')}">${escapeHtml(supportEmail)}</a>
from the email address you use on Mela, and tell us your @username. We delete the account within 7 days and write back
when it's done.</p>`
    : `<p>Install Mela again, sign in, and follow the steps above.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Delete your Mela account</title>
<meta name="description" content="How to delete your Mela account, and what is deleted." />
<meta name="theme-color" content="#0E0E14" />
<style>
:root { color-scheme: dark; }
html, body { margin: 0; background: #0e0e14; color: #f5f5f7; font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
main { width: min(100% - 48px, 640px); margin: 0 auto; padding: 48px 0 64px; }
.logo svg { height: 40px; width: auto; }
h1 { margin: 28px 0 8px; font-size: 28px; line-height: 1.25; }
h2 { margin: 32px 0 8px; font-size: 18px; }
p, li { color: #c9c9d4; }
.lead { font-size: 17px; }
ol, ul { padding-left: 22px; }
li { margin: 4px 0; }
a { color: ${MELA_COLORS.teal}; font-weight: 600; }
strong { color: #f5f5f7; }
</style>
</head>
<body>
<main>
<div class="logo">${MELA_LOGO_SVG}</div>
<h1>Delete your Mela account</h1>
<p class="lead">You can delete your Mela account, and everything you made on Mela, whenever you like.
It happens straight away and can't be undone.</p>

<h2>In the Mela app</h2>
<ol>
<li>Open Mela and go to your <strong>Profile</strong>.</li>
<li>Tap <strong>Settings</strong>, then <strong>Delete account</strong>.</li>
<li>Confirm with your password - or with Google, if you signed up with Google.</li>
</ol>

<h2>Without the app</h2>
${withoutApp}

<h2>What is deleted</h2>
<ul>
<li>Your account: your name, username, email, password, profile picture and bio, and your sign-in with Google.</li>
<li>Your lives, with their chat, photos and guests.</li>
<li>Your chat messages in other people's lives, and your private messages - for the people you wrote to as well.</li>
<li>Who you follow and who follows you, your blocks and mutes, your notifications and settings.</li>
<li>You're signed out on every device.</li>
</ul>

<h2>What is kept</h2>
<ul>
<li>Reports you made, without your name, and reports made about your account, with what was reported - so our safety team can finish reviewing them.</li>
<li>A record of what happened on your account for security and safety - that it was deleted, for example - without your name or IP address.</li>
</ul>
</main>
</body>
</html>`;
}
