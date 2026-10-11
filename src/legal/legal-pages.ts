import { MELA_COLORS, MELA_LOGO_SVG } from '../share/brand';
import { escapeHtml } from '../share/share-page';
import { LEGAL_PATHS, LEGAL_VERSION, MINIMUM_AGE } from './legal-rules';

/**
 * The Terms of Service and Privacy Policy pages (`/terms`, `/privacy`) -
 * linked from sign-up, the app's settings and the store listing. Plain
 * static HTML like the account deletion page: no script, no cookies.
 *
 * Written from what Mela actually does; have them reviewed by a lawyer for
 * the countries Mela is offered in, then bump LEGAL_VERSION on any change
 * people must agree to again. See docs/features/legal.md.
 */
export interface LegalPageContext {
  /** Who runs Mela - LEGAL_OPERATOR_NAME, or "Mela". */
  operator: string;
  supportEmail: string | null;
}

/** "12 October 2026" - when this version took effect. */
function effectiveDate(): string {
  const [year, month, day] = LEGAL_VERSION.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function contact(context: LegalPageContext): string {
  return context.supportEmail
    ? `<a href="mailto:${escapeHtml(context.supportEmail)}">${escapeHtml(context.supportEmail)}</a>`
    : 'the support option in the Mela app';
}

function page(title: string, description: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${title} - Mela</title>
<meta name="description" content="${description}" />
<meta name="theme-color" content="#0E0E14" />
<style>
:root { color-scheme: dark; }
html, body { margin: 0; background: #0e0e14; color: #f5f5f7; font: 16px/1.65 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
main { width: min(100% - 48px, 720px); margin: 0 auto; padding: 48px 0 64px; }
.logo svg { height: 40px; width: auto; }
h1 { margin: 28px 0 4px; font-size: 28px; line-height: 1.25; }
.meta { margin: 0 0 24px; color: #9c9cac; font-size: 14px; }
h2 { margin: 36px 0 8px; font-size: 19px; }
h3 { margin: 20px 0 4px; font-size: 16px; }
p, li { color: #c9c9d4; }
ul, ol { padding-left: 22px; }
li { margin: 6px 0; }
a { color: ${MELA_COLORS.teal}; font-weight: 600; }
strong { color: #f5f5f7; }
.summary { border: 1px solid #2d2d3d; border-radius: 12px; padding: 4px 20px; background: #191922; }
nav { margin-top: 48px; padding-top: 16px; border-top: 1px solid #2d2d3d; font-size: 14px; }
nav a { margin-right: 16px; }
</style>
</head>
<body>
<main>
<div class="logo">${MELA_LOGO_SVG}</div>
${body}
<nav><a href="${LEGAL_PATHS.terms}">Terms of Service</a><a href="${LEGAL_PATHS.privacy}">Privacy Policy</a><a href="/delete-account">Delete your account</a></nav>
</main>
</body>
</html>`;
}

export function renderTermsPage(context: LegalPageContext): string {
  const operator = escapeHtml(context.operator);
  return page(
    'Terms of Service',
    'The rules for using Mela, the live streaming app.',
    `<h1>Terms of Service</h1>
<p class="meta">Effective ${effectiveDate()} · Version ${LEGAL_VERSION}</p>

<div class="summary">
<p><strong>In short:</strong> Mela is for adults ${MINIMUM_AGE} and over. You own what you stream and post, and you're
responsible for it. Treat people with respect and follow the community rules below - we remove content and close
accounts that don't. You can delete your account whenever you like.</p>
</div>

<h2>1. About these terms</h2>
<p>These terms are an agreement between you and ${operator} ("Mela", "we", "us") for using the Mela app and website
(together, "Mela"). By creating an account or using Mela, you agree to these terms and to our
<a href="${LEGAL_PATHS.privacy}">Privacy Policy</a>. If you don't agree, please don't use Mela.</p>

<h2>2. Who can use Mela</h2>
<ul>
<li>You must be at least <strong>${MINIMUM_AGE} years old</strong>. We ask for your date of birth when you sign up and
close accounts of anyone younger.</li>
<li>You must be allowed to use Mela under the laws where you live, and not have been banned from Mela before.</li>
<li>The information you give us, including your date of birth, must be true.</li>
</ul>

<h2>3. Your account</h2>
<ul>
<li>Keep your password and the devices you're signed in on safe. You're responsible for what happens on your
account. Tell us straight away if you think someone else is using it.</li>
<li>Your username and display name must not pretend to be someone else, mislead people, or break the community
rules. You can change your username once every 30 days and your display name once every 7 days.</li>
<li>You may have several accounts, but not to get around a ban, block or limit, or to make yourself look more
popular than you are.</li>
</ul>

<h2>4. Going live, chatting and your content</h2>
<ul>
<li><strong>You own your content</strong> - your lives, chat messages, photos, profile and anything else you post.</li>
<li>So that Mela can work, you give us a worldwide, non-exclusive, royalty-free licence to host, store, transmit,
display and distribute your content on Mela - for example, to stream your live to its viewers, show a preview of
it in the list of lives, and show your profile. This licence ends when you delete the content or your account,
except where others have already received it (like a message you sent) or we must keep it (see the Privacy
Policy).</li>
<li>You are responsible for what you stream and post, and you confirm you have the rights to it - including music,
video and images, and the permission of anyone who appears in your live.</li>
<li>When you invite guests on stage, you are responsible for your live. Guests are responsible for what they say and
show.</li>
<li>Don't record, save or share other people's lives or messages without their permission. Mela keeps lives out of
screen recordings unless the host allows it.</li>
</ul>

<h2>5. Community rules</h2>
<p>Don't use Mela to post, stream, send or promote:</p>
<ul>
<li><strong>Anything involving minors in a sexual way.</strong> We have zero tolerance: we remove it, close the
account and report it to the authorities.</li>
<li>Nudity, sexual acts or sexually explicit content.</li>
<li>Violence, threats, or content that encourages people to hurt themselves or others.</li>
<li>Harassment, bullying, or hate against people because of who they are - such as race, ethnicity, religion,
nationality, sex, gender, sexual orientation or disability.</li>
<li>Scams, spam, fake giveaways, or misleading people for money or personal information.</li>
<li>Illegal activity - including illegal or unlicensed gambling, drugs or weapons trading - or anything illegal
where you or your viewers are.</li>
<li>Someone else's private information, such as their address, phone number or private photos.</li>
<li>Content that infringes someone else's copyright, trademark or other rights.</li>
<li>Pretending to be another person, brand or Mela.</li>
</ul>
<p>Also don't try to get around bans, blocks, mutes or limits; access other people's accounts; disrupt, overload or
reverse-engineer Mela; or use bots or automated means to use it.</p>

<h2>6. Safety and moderation</h2>
<ul>
<li>Hosts and the moderators they choose can delete chat messages and mute or ban people from their lives.</li>
<li>You can block anyone, and report lives, messages and accounts from the app. Our safety team reviews reports.</li>
<li>We may remove content, end lives, restrict features, or suspend or close accounts that break these terms or the
law, or that put people at risk - with or without notice, as the situation needs. We may also keep information and
share it with the authorities when the law requires it or someone's safety is at risk.</li>
<li>If you think we got a decision wrong, contact us at ${contact(context)} and we'll look at it again.</li>
</ul>

<h2>7. Private messages</h2>
<p>You can send private messages to friends (people who follow each other). Messages that are reported may be
reviewed by our safety team.</p>

<h2>8. Mela itself</h2>
<ul>
<li>We work to keep Mela running well, but it's provided "as is". Lives can drop or lag on weak connections, and
features may change, be paused or stop. Test versions may contain mistakes.</li>
<li>Mela uses other companies' services to work (see the Privacy Policy). Their terms may also apply to you - for
example Google's, when you sign in with Google.</li>
<li>The Mela name, logo and app belong to us. These terms don't give you any right to use them.</li>
</ul>

<h2>9. Ending your use of Mela</h2>
<p>You can stop using Mela and <a href="/delete-account">delete your account</a> at any time from the app's settings.
We may suspend or close your account as described in section 6. Sections 4 (for content others already received), 8,
10 and 11 continue to apply after your account ends.</p>

<h2>10. Liability</h2>
<p>To the extent the law allows, we aren't liable for content posted by users, for losses you couldn't reasonably
foresee, or for indirect losses such as lost profits or data. Nothing in these terms limits liability that can't be
limited by law, or your rights as a consumer.</p>

<h2>11. Changes to these terms</h2>
<p>We may update these terms - for example when Mela changes or the law requires it. When the change matters, we'll
ask you to read and accept the new version in the app before you continue. The version and date are at the top of
this page.</p>

<h2>12. Contact</h2>
<p>Questions about these terms: ${contact(context)}.</p>`,
  );
}

export function renderPrivacyPage(context: LegalPageContext): string {
  const operator = escapeHtml(context.operator);
  return page(
    'Privacy Policy',
    'What Mela collects, why, who sees it, and your choices.',
    `<h1>Privacy Policy</h1>
<p class="meta">Effective ${effectiveDate()} · Version ${LEGAL_VERSION}</p>

<div class="summary">
<p><strong>In short:</strong> we collect what Mela needs to work and to keep people safe. We don't sell your data and
we don't show ads. Your lives are streamed live, not recorded by us. You control your profile's privacy and can
delete your account and its data at any time.</p>
</div>

<h2>1. Who we are</h2>
<p>Mela is run by ${operator} ("Mela", "we", "us"). This policy explains how we handle your personal information when
you use the Mela app and website. Contact: ${contact(context)}.</p>

<h2>2. What we collect</h2>
<h3>Your account</h3>
<ul>
<li>Your email address, username, display name and password (stored only as a secure hash, never in readable form).</li>
<li>If you sign in with Google: your Google account's id, email and name, which Google shares with us.</li>
<li>Your <strong>date of birth</strong>, to check you're ${MINIMUM_AGE} or older.</li>
<li>When you accepted our Terms of Service and this policy, and which version.</li>
</ul>
<h3>What you add and do on Mela</h3>
<ul>
<li>Your profile: picture, bio, and your privacy and notification settings.</li>
<li>Who you follow, block and mute; your likes; the reminders you set for upcoming lives.</li>
<li>The lives you host: title, category, who could watch, when it ran, viewer counts, its guests and moderators, and
preview images taken from it to show it in the list of lives.</li>
<li>Chat messages and photos you send in lives, and your private messages.</li>
<li>Reports you make, and reports and moderation decisions about your account.</li>
</ul>
<h3>Live video and sound</h3>
<p>Your camera and microphone are used only while you're live or on stage. Video and sound are sent in real time to
the people watching; <strong>Mela does not record or store your lives</strong>, apart from the preview images above.</p>
<h3>Your device and connection</h3>
<ul>
<li>Your device type and app version, a random id for the app on your phone, and a push notification token.</li>
<li>Your IP address and the times you use Mela, in our security logs and staff audit records.</li>
</ul>

<h2>3. How we use it</h2>
<ul>
<li>To run Mela: your account, sign-in, live streaming, chat, messages, follows and notifications.</li>
<li>To check you're old enough to use Mela.</li>
<li>To keep Mela safe: reviewing reports, enforcing our rules, preventing spam, abuse and fraud, and securing accounts.</li>
<li>To show you lives you may like, using who you follow and how popular lives are - never by selling or sharing
your data with advertisers.</li>
<li>To answer you when you contact us, and to meet our legal obligations.</li>
</ul>
<p>Where the law needs a legal basis, we rely on our agreement with you (to provide Mela), our legitimate interest in
keeping Mela safe and working, your consent where we ask for it (such as push notifications), and our legal
obligations.</p>

<h2>4. Who can see what</h2>
<ul>
<li><strong>Everyone</strong> can see your display name, username and profile picture.</li>
<li>Your bio, followers and who you follow are visible to the people you choose in <strong>Profile privacy</strong>.</li>
<li>People in a live see its video, sound and chat. A followers' or friends' live is only for those people.</li>
<li>Private messages are seen by you and the person you wrote to, and by our safety team when they're reported.</li>
<li>When you join a live, your followers may be told - you can turn this off in Profile privacy.</li>
<li>Our staff can see account and moderation information when they need it to support you or keep Mela safe. Their
access is logged.</li>
</ul>

<h2>5. Companies that help us run Mela</h2>
<p>We share information only with service providers that run parts of Mela for us, under contract, and only as
needed:</p>
<ul>
<li><strong>Google Firebase</strong> - sign-in, email confirmation and push notifications.</li>
<li><strong>Google Sign-In</strong> - if you choose to sign in with Google.</li>
<li><strong>Hosting and storage providers</strong> - the servers and storage that run Mela, carry live video and hold
pictures.</li>
<li><strong>A live video provider</strong>, when one is used to carry lives.</li>
</ul>
<p>We may also share information if the law requires it, to protect someone's safety, or as part of a merger or sale
of Mela (you'd be told). <strong>We do not sell your personal information</strong>, and we don't use advertising
trackers.</p>

<h2>6. How long we keep it</h2>
<ul>
<li>We keep your account and content while you have an account.</li>
<li>When you <a href="/delete-account">delete your account</a>, we delete your profile, lives, chat messages, private
messages, follows and settings straight away.</li>
<li>We keep a limited record afterwards only where we need it: reports and moderation records so our safety team can
finish reviewing them, and security and audit records without your name or IP address.</li>
<li>Security logs are kept for a limited time and then deleted.</li>
</ul>

<h2>7. Your choices and rights</h2>
<ul>
<li>Edit your profile, change who sees it, and choose which notifications you get - all in the app.</li>
<li>Block, mute or report anyone.</li>
<li>Turn off push notifications in the app or in your phone's settings, and the camera or microphone in your phone's
settings.</li>
<li>Delete your account at any time.</li>
<li>Ask us for a copy of your information, or to correct or delete it, by writing to ${contact(context)}. Depending on
where you live, you may have other rights - such as to object or to complain to your data protection authority.</li>
</ul>

<h2>8. Security</h2>
<p>We protect your information with encryption in transit, hashed passwords, access controls and logging. No system
is perfectly secure, so please use a strong password and keep your devices safe.</p>

<h2>9. Mela is for adults</h2>
<p>Mela is not for anyone under ${MINIMUM_AGE}. If we learn that someone under ${MINIMUM_AGE} has an account, we close
it and delete their information. If you think a child is using Mela, please report the account or contact us.</p>

<h2>10. Where your information is processed</h2>
<p>Our servers and providers may be in countries other than yours. When we move information across borders, we use
the protections the law requires.</p>

<h2>11. Changes to this policy</h2>
<p>If we change this policy in a way that matters, we'll ask you to read and accept the new version in the app. The
version and date are at the top of this page.</p>

<h2>12. Contact</h2>
<p>Questions or requests about your privacy: ${contact(context)}.</p>`,
  );
}
