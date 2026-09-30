/* eslint-disable */
/**
 * Manual smoke test for the admin console API against a running dev server
 * (real Postgres, Redis and Socket.IO). A disposable super admin signs in,
 * is held at the password change, changes it, then works through the
 * console: overview, a live's detail and chat log, deleting a message, a
 * stream alert and a global one (received by a real viewer socket), locking
 * the live (the room hears why, then the end) and
 * unlocking it, editing a profile, suspending (the app token stops working,
 * login says why) and reinstating, banned phrases, staff (a platform
 * moderator who can do only what they were given, until that changes), and
 * the audit log with its CSV export - then signs out. The disposable admins
 * are deleted at the end; the app users it creates stay, like the realtime
 * smoke test's.
 *
 * Usage: node scripts/smoke-test-admin.js
 * Requires the dev server at API_ORIGIN (.env - or the shell, to test another one).
 */
const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const { randomBytes } = require('crypto');
const { io } = require('socket.io-client');
const { requireEnv } = require('./dev-env');

const { API_ORIGIN: ORIGIN } = requireEnv('API_ORIGIN');
const BASE_URL = `${ORIGIN}/v1`;
const CONSOLE = { 'X-Requested-With': 'admin-console' };
// The app users stay behind - never with a guessable password.
const USER_PASSWORD = `Pw-${randomBytes(12).toString('hex')}`;
const prisma = new PrismaClient();

async function request(path, { method = 'GET', token, body, headers = {}, cookie } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function api(path, options = {}) {
  const res = await request(path, options);
  if (res.status >= 400) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const errorCode = (res) => res.body?.message?.code ?? res.body?.code;

function refreshCookie(res) {
  const cookie = res.headers.getSetCookie().find((value) => value.startsWith('gl_admin_refresh='));
  return cookie;
}

async function signup(name) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const tokens = await api('/auth/signup', {
    method: 'POST',
    body: {
      username: `${name}${suffix}`,
      displayName: `Smoke ${name}`,
      email: `${name}${suffix}@example.com`,
      password: USER_PASSWORD,
    },
  });
  const me = await api('/users/me', { token: tokens.accessToken });
  return { ...tokens, id: me.id, username: me.username, email: `${name}${suffix}@example.com` };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(ORIGIN, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

const next = (socket, event) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within 5s`)), 5000);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
const ack = (socket, event, payload) => socket.timeout(5000).emitWithAck(event, payload);

async function main() {
  const stamp = Date.now();
  const email = `smoke-admin-${stamp}@example.test`;
  const admin = await prisma.user.create({
    data: {
      email,
      username: `smoke_admin_${stamp}`,
      displayName: 'Smoke Admin',
      passwordHash: await argon2.hash('Smoke-temp-pass-1'),
      platformRole: 'SUPER_ADMIN',
      passwordChangeRequired: true,
    },
  });
  const sockets = [];
  const moderatorEmail = `smoke-moderator-${stamp}@example.test`;
  try {
    // Sign-in: generic refusal, then a session cookie only the auth routes see.
    const wrong = await request('/admin/auth/sign-in', { method: 'POST', body: { email, password: 'nope-nope-nope' } });
    expect(wrong.status === 401, `wrong password: ${wrong.status}`);
    const signIn = await request('/admin/auth/sign-in', { method: 'POST', body: { email, password: 'Smoke-temp-pass-1' } });
    expect(signIn.status === 200, `sign-in: ${signIn.status} ${JSON.stringify(signIn.body)}`);
    let cookieHeader = refreshCookie(signIn);
    expect(/HttpOnly/i.test(cookieHeader) && /SameSite=Strict/i.test(cookieHeader), `cookie flags: ${cookieHeader}`);
    expect(/Path=\/v1\/admin\/auth/i.test(cookieHeader), `cookie path: ${cookieHeader}`);
    expect(!('refreshToken' in signIn.body), 'the refresh token must never be in the body');
    let token = signIn.body.accessToken;
    let cookie = cookieHeader.split(';')[0];
    expect(signIn.body.admin.passwordChangeRequired === true, 'a new account must change its password');
    console.log('signed in; refresh cookie:', cookieHeader.split(';').slice(1).join(';').trim());

    // Held at the password change until it's done.
    const held = await request('/admin/overview', { token });
    expect(held.status === 403 && errorCode(held) === 'PASSWORD_CHANGE_REQUIRED', `held: ${JSON.stringify(held.body)}`);
    const weak = await request('/admin/me/password', {
      method: 'POST',
      token,
      body: { currentPassword: 'Smoke-temp-pass-1', newPassword: 'short1' },
    });
    expect(weak.status === 400, `weak password: ${weak.status}`);
    const changed = await api('/admin/me/password', {
      method: 'POST',
      token,
      body: { currentPassword: 'Smoke-temp-pass-1', newPassword: 'Smoke-real-pass-2' },
    });
    expect(changed.passwordChangeRequired === false, 'password change should clear the flag');
    console.log('password changed; console unlocked');

    // Refresh: needs the console header, rotates the cookie.
    const forged = await request('/admin/auth/refresh', { method: 'POST', cookie });
    expect(forged.status === 403, `refresh without the console header: ${forged.status}`);
    const refreshed = await request('/admin/auth/refresh', { method: 'POST', cookie, headers: CONSOLE });
    expect(refreshed.status === 200, `refresh: ${refreshed.status} ${JSON.stringify(refreshed.body)}`);
    token = refreshed.body.accessToken;
    cookie = refreshCookie(refreshed).split(';')[0];
    console.log('refreshed via cookie');

    const overview = await api('/admin/overview', { token });
    console.log('overview:', JSON.stringify(overview).slice(0, 200), '...');

    // A live with a real viewer socket.
    const host = await signup('ahost');
    const viewer = await signup('aviewer');
    const live = await api('/streams', {
      method: 'POST',
      token: host.accessToken,
      body: { title: `Smoke admin live ${stamp}`, category: 'smoke-poker', layout: 'SPLIT' },
    });
    const streamId = live.stream.id;
    const hostSocket = await connect(host.accessToken);
    sockets.push(hostSocket);
    await ack(hostSocket, 'stream:host_join', { streamId });
    const viewerSocket = await connect(viewer.accessToken);
    sockets.push(viewerSocket);
    const joined = await ack(viewerSocket, 'stream:join', { streamId });
    expect(joined.ok, `viewer join: ${JSON.stringify(joined)}`);

    const streams = await api(`/admin/streams?status=LIVE&q=${encodeURIComponent(`Smoke admin live ${stamp}`)}`, { token });
    expect(streams.total === 1 && streams.items[0].id === streamId, `admin stream list: ${JSON.stringify(streams)}`);
    expect(streams.items[0].viewerCount === 1, `viewer count: ${streams.items[0].viewerCount}`);
    const detail = await api(`/admin/streams/${streamId}`, { token });
    expect(detail.status === 'LIVE' && detail.host.id === host.id, `detail: ${JSON.stringify(detail)}`);
    console.log('live listed with its viewer:', streams.items[0].title);

    // Chat log and deleting a message, seen by the room.
    const sent = await ack(viewerSocket, 'chat:send', { streamId, text: 'smoke message to delete', clientId: `s-${stamp}` });
    expect(sent.ok, `chat send: ${JSON.stringify(sent)}`);
    const chat = await api(`/admin/streams/${streamId}/chat`, { token });
    expect(chat.items.some((message) => message.id === sent.message.id), 'chat log should have the message');
    const deletedEvent = next(hostSocket, 'chat:deleted');
    await api(`/admin/streams/${streamId}/chat/${sent.message.id}`, { method: 'DELETE', token });
    expect((await deletedEvent).messageId === sent.message.id, 'the room should hear the delete');
    console.log('message deleted from the console and removed in the room');

    // Alerts, stream and global.
    const streamAlert = next(viewerSocket, 'admin:alert');
    const alert = await api('/admin/alerts', {
      method: 'POST',
      token,
      body: { scope: 'STREAM', streamId, message: 'Please keep chat respectful.', severity: 'WARNING' },
    });
    const receivedAlert = await streamAlert;
    expect(receivedAlert.id === alert.id && receivedAlert.severity === 'WARNING', `stream alert: ${JSON.stringify(receivedAlert)}`);
    expect(alert.recipientCount >= 1, `recipients: ${alert.recipientCount}`);
    const globalAlert = next(viewerSocket, 'admin:alert');
    await api('/admin/alerts', {
      method: 'POST',
      token,
      body: { scope: 'GLOBAL', message: 'Smoke test: maintenance notice.', severity: 'INFO' },
    });
    expect((await globalAlert).scope === 'GLOBAL', 'global alert should reach every app');
    console.log('stream and global alerts delivered; recipients:', alert.recipientCount);

    // Lock: the room hears why, then the live ends as LOCKED.
    const locked = next(viewerSocket, 'stream:locked');
    const endedForViewer = next(viewerSocket, 'stream_ended');
    const afterLock = await api(`/admin/streams/${streamId}/lock`, { method: 'POST', token, body: { reason: 'Smoke test lock' } });
    expect((await locked).reason === 'Smoke test lock', 'the room should hear the lock reason');
    const ended = await endedForViewer;
    expect(ended.reason === 'LOCKED' && ended.message === 'Smoke test lock', `stream_ended: ${JSON.stringify(ended)}`);
    expect(afterLock.status === 'LOCKED' && afterLock.lockedBy.id === admin.id, `lock detail: ${JSON.stringify(afterLock)}`);
    const relock = await request(`/admin/streams/${streamId}/lock`, { method: 'POST', token, body: { reason: 'again' } });
    expect(relock.status === 409, `locking a locked live: ${relock.status}`);
    const unlocked = await api(`/admin/streams/${streamId}/unlock`, { method: 'POST', token });
    expect(unlocked.status === 'ENDED', `unlock: ${unlocked.status}`);
    console.log('locked (room told why), then unlocked:', unlocked.status);

    // Profile edit, suspension, reinstatement.
    const edited = await api(`/admin/users/${viewer.id}/profile`, {
      method: 'PATCH',
      token,
      body: { displayName: 'Renamed by staff', reason: 'Smoke test rename' },
    });
    expect(edited.displayName === 'Renamed by staff', `edit profile: ${JSON.stringify(edited)}`);
    const suspended = await api(`/admin/users/${viewer.id}/suspend`, { method: 'POST', token, body: { reason: 'Smoke suspension' } });
    expect(suspended.ok, 'suspend');
    const deadToken = await request('/users/me', { token: viewer.accessToken });
    expect(deadToken.status === 401, `a suspended user's access token should stop working: ${deadToken.status}`);
    const blockedLogin = await request('/auth/login', {
      method: 'POST',
      body: { usernameOrEmail: viewer.username, password: USER_PASSWORD },
    });
    expect(blockedLogin.status === 403 && errorCode(blockedLogin) === 'ACCOUNT_SUSPENDED', `suspended login: ${JSON.stringify(blockedLogin.body)}`);
    await api(`/admin/users/${viewer.id}/reinstate`, { method: 'POST', token });
    await api('/auth/login', { method: 'POST', body: { usernameOrEmail: viewer.username, password: USER_PASSWORD } });
    const userDetail = await api(`/admin/users/${viewer.id}`, { token });
    expect(userDetail.status === 'ACTIVE', `user detail: ${JSON.stringify(userDetail)}`);
    console.log('profile edited, suspended (token dead, login refused with reason), reinstated');

    // Banned phrases.
    const phrase = await api('/admin/banned-phrases', {
      method: 'POST',
      token,
      body: { phrase: `  Smoke   Phrase ${stamp} `, severity: 'MASK' },
    });
    expect(phrase.phrase === `smoke phrase ${stamp}`, `phrase normalised: ${phrase.phrase}`);
    const duplicate = await request('/admin/banned-phrases', {
      method: 'POST',
      token,
      body: { phrase: `smoke phrase ${stamp}`, severity: 'REJECT' },
    });
    expect(duplicate.status === 409, `duplicate phrase: ${duplicate.status}`);
    const tried = await api('/admin/banned-phrases/test', { method: 'POST', token, body: { text: `hello smoke phrase ${stamp}!` } });
    expect(tried.outcome === 'MASKED' && !tried.delivered.includes('smoke'), `phrase test: ${JSON.stringify(tried)}`);
    await api(`/admin/banned-phrases/${phrase.id}`, { method: 'DELETE', token });
    console.log('banned phrase added, tested, removed');

    const staff = await api('/admin/staff', { token });
    expect(staff.items.some((member) => member.id === admin.id), 'staff list should include the admin');

    // A platform moderator can do only what a super admin gave them.
    const newModerator = { email: moderatorEmail, displayName: 'Smoke Moderator', platformRole: 'PLATFORM_MODERATOR' };
    const noAccess = await request('/admin/staff', { method: 'POST', token, body: newModerator });
    expect(noAccess.status === 400, `a moderator must be given something: ${noAccess.status}`);
    const created = await api('/admin/staff', {
      method: 'POST',
      token,
      body: { ...newModerator, permissions: ['MANAGE_PHRASES'] },
    });
    expect(created.user.permissions.join() === 'VIEW_PHRASES,MANAGE_PHRASES', `granted: ${created.user.permissions}`);
    const moderatorSignIn = await api('/admin/auth/sign-in', {
      method: 'POST',
      body: { email: moderatorEmail, password: created.temporaryPassword },
    });
    const modToken = moderatorSignIn.accessToken;
    await api('/admin/me/password', {
      method: 'POST',
      token: modToken,
      body: { currentPassword: created.temporaryPassword, newPassword: 'Smoke-moderator-pass-3' },
    });
    expect((await request('/admin/banned-phrases', { token: modToken })).status === 200, 'the moderator can work banned phrases');
    const noUsers = await request('/admin/users', { token: modToken });
    expect(noUsers.status === 403 && errorCode(noUsers) === 'MISSING_PERMISSION', `users: ${JSON.stringify(noUsers.body)}`);
    const noLock = await request(`/admin/streams/${streamId}/unlock`, { method: 'POST', token: modToken });
    expect(noLock.status === 403, `lives: ${noLock.status}`);
    const noGrant = await request(`/admin/users/${created.user.id}/permissions`, {
      method: 'PATCH',
      token: modToken,
      body: { permissions: ['MANAGE_USERS'] },
    });
    expect(noGrant.status === 403, `a moderator can't change access: ${noGrant.status}`);

    await api(`/admin/users/${created.user.id}/permissions`, {
      method: 'PATCH',
      token,
      body: { permissions: ['MANAGE_PHRASES', 'VIEW_USERS'] },
    });
    expect((await request('/admin/users', { token: modToken })).status === 200, 'new access applies at the next request');
    const noSuspend = await request(`/admin/users/${viewer.id}/suspend`, {
      method: 'POST',
      token: modToken,
      body: { reason: 'Only allowed to look' },
    });
    expect(noSuspend.status === 403, `viewing users is not managing them: ${noSuspend.status}`);
    const moderatorView = await api('/admin/me', { token: modToken });
    expect(moderatorView.permissions.join() === 'VIEW_USERS,VIEW_PHRASES,MANAGE_PHRASES', `me: ${moderatorView.permissions}`);
    console.log('platform moderator limited to what they were given; a change applied at their next request');

    // The audit trail has all of it, filterable, and exports.
    const viewerTrail = await api(`/admin/audit-logs?userId=${viewer.id}&pageSize=100`, { token });
    const actions = viewerTrail.items.map((entry) => entry.action);
    for (const action of ['auth.signed_up', 'user.profile_edited', 'user.suspended', 'user.reinstated']) {
      expect(actions.includes(action), `audit should have ${action}: ${actions.join(', ')}`);
    }
    const streamTrail = await api(`/admin/audit-logs?streamId=${streamId}&category=STREAM`, { token });
    expect(streamTrail.items.some((entry) => entry.action === 'stream.locked' && entry.reason === 'Smoke test lock'), 'lock entry');
    const byAdmin = await api(`/admin/audit-logs?actorId=${admin.id}&pageSize=100`, { token });
    const lockEntry = byAdmin.items.find((entry) => entry.action === 'stream.locked');
    expect(lockEntry?.actorRole === 'SUPER_ADMIN' && lockEntry.ip, `admin entries carry role and IP: ${JSON.stringify(lockEntry)}`);
    const accessEntry = byAdmin.items.find((entry) => entry.action === 'user.permissions_changed');
    expect(accessEntry?.metadata?.to?.includes('VIEW_USERS'), `access change recorded: ${JSON.stringify(accessEntry)}`);
    const searched = await api(`/admin/audit-logs?q=${encodeURIComponent('suspended an account')}&userId=${viewer.id}`, { token });
    expect(searched.items.some((entry) => entry.action === 'user.suspended'), 'search by the words shown');
    // Raw bytes: fetch's text() strips a leading BOM.
    const csvRes = await fetch(`${BASE_URL}/admin/audit-logs/export?userId=${viewer.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const csvBytes = Buffer.from(await csvRes.arrayBuffer());
    expect(csvRes.status === 200, `CSV export: ${csvRes.status}`);
    expect(csvBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'CSV export starts with a UTF-8 BOM');
    expect(/attachment; filename="audit-log\.csv"/.test(csvRes.headers.get('content-disposition') ?? ''), 'CSV download name');
    const csv = csvBytes.toString('utf8');
    expect(csv.includes('Suspended an account'), 'CSV has readable action labels');
    console.log(`audit: ${viewerTrail.total} entries for the viewer, ${byAdmin.total} by the admin; CSV ${csv.length} chars`);

    // Signing out ends the cookie session.
    const signedOut = await request('/admin/auth/sign-out', { method: 'POST', cookie, headers: CONSOLE });
    expect(signedOut.status === 204, `sign-out: ${signedOut.status}`);
    const afterSignOut = await request('/admin/auth/refresh', { method: 'POST', cookie, headers: CONSOLE });
    expect(afterSignOut.status === 401, `refresh after sign-out: ${afterSignOut.status}`);
    const staleAccess = await request('/admin/overview', { token });
    expect(staleAccess.status === 401, `access token after sign-out: ${staleAccess.status}`);
    console.log('signed out: cookie and access token both dead');

    console.log('\nADMIN SMOKE TEST PASSED');
  } finally {
    for (const socket of sockets) socket.close();
    await prisma.user.deleteMany({ where: { email: moderatorEmail } }).catch((error) => console.warn('cleanup:', error.message));
    await prisma.user.delete({ where: { id: admin.id } }).catch((error) => console.warn('cleanup:', error.message));
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('ADMIN SMOKE TEST FAILED:', error);
  process.exitCode = 1;
});
