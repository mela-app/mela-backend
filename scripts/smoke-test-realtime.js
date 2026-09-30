/* eslint-disable */
/**
 * Manual smoke test for the realtime pipeline against a running dev server
 * (real Postgres, Redis and Socket.IO). A host goes live and joins as host;
 * one viewer watches from two devices (counted once); a second host's
 * quieter live ranks below; layout, "away" and pause are relayed; chat is
 * cleaned, relayed, rate-limited and paged; likes are totalled; the ended
 * live reports its reason, peak and likes; a signed-out session's socket is
 * refused.
 *
 * Usage: node scripts/smoke-test-realtime.js
 * Requires the dev server running at API_ORIGIN (.env).
 */
const { randomBytes } = require('crypto');
const { io } = require('socket.io-client');
const { requireEnv } = require('./dev-env');

const { API_ORIGIN: ORIGIN } = requireEnv('API_ORIGIN');
const BASE_URL = `${ORIGIN}/v1`;
// The users stay behind - never with a guessable password.
const USER_PASSWORD = `Pw-${randomBytes(12).toString('hex')}`;

async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function signup(name) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return api('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      username: `${name}${suffix}`,
      displayName: `Smoke ${name}`,
      email: `${name}${suffix}@example.com`,
      password: USER_PASSWORD,
    }),
  });
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

const next = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
const ack = (socket, event, payload) => socket.timeout(5000).emitWithAck(event, payload);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function goLive(token, title, layout = 'SPLIT') {
  return api('/streams', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, category: 'smoke-poker', layout }),
  });
}

async function main() {
  const host = await signup('host');
  const quietHost = await signup('quiet');
  const viewer = await signup('viewer');

  const live = await goLive(host.accessToken, 'Smoke busy live');
  const streamId = live.stream.id;
  expect(live.stream.layout === 'SPLIT', `expected layout SPLIT, got ${live.stream.layout}`);
  expect(live.stream.host?.displayName === 'Smoke host', 'go-live response should include the host');
  expect(typeof live.serverTime === 'string', 'go-live response should include serverTime');
  console.log('went live:', streamId, 'provider:', live.rtcToken.provider);
  const quiet = await goLive(quietHost.accessToken, 'Smoke quiet live', 'FULL');

  const hostSocket = await connect(host.accessToken);
  const hostJoin = await ack(hostSocket, 'stream:host_join', { streamId });
  expect(hostJoin.ok && hostJoin.viewerCount === 0, `host_join: ${JSON.stringify(hostJoin)}`);
  const notHost = await ack(hostSocket, 'stream:host_join', { streamId: quiet.stream.id });
  expect(!notHost.ok && notHost.error === 'NOT_HOST', `joining someone else's live as host: ${JSON.stringify(notHost)}`);
  const heartbeat = await ack(hostSocket, 'stream:host_heartbeat', { streamId });
  expect(heartbeat.ok, `heartbeat: ${JSON.stringify(heartbeat)}`);
  console.log('host joined and heartbeat acknowledged');

  // One person watching from two devices counts once.
  const phone = await connect(viewer.accessToken);
  const tablet = await connect(viewer.accessToken);
  const firstCount = next(hostSocket, 'viewer_count_update');
  const phoneJoin = await ack(phone, 'stream:join', { streamId });
  expect(phoneJoin.ok && phoneJoin.layout === 'SPLIT' && phoneJoin.hostAway === false, `join: ${JSON.stringify(phoneJoin)}`);
  console.log('host sees viewer_count_update:', await firstCount);
  const tabletJoin = await ack(tablet, 'stream:join', { streamId });
  expect(tabletJoin.ok && tabletJoin.viewerCount === 1, `second device should not add a viewer: ${JSON.stringify(tabletJoin)}`);
  const rejoin = await ack(phone, 'stream:join', { streamId });
  expect(rejoin.viewerCount === 1, `rejoining should not double count: ${JSON.stringify(rejoin)}`);
  console.log('two devices of one viewer count as', tabletJoin.viewerCount);

  const invalid = await ack(phone, 'stream:join', { streamId: 'nope' });
  expect(!invalid.ok && invalid.error === 'INVALID_PAYLOAD', `invalid join: ${JSON.stringify(invalid)}`);

  // The busier live ranks first in discovery.
  const list = await api('/streams?category=Smoke-Poker');
  const ranked = list.items.map((item) => [item.title, item.viewerCount]);
  console.log('discovery ranking:', JSON.stringify(ranked));
  expect(list.items[0].id === streamId && list.items[0].viewerCount === 1, 'busiest live should rank first');
  expect(list.items.some((item) => item.id === quiet.stream.id), 'quiet live should be listed');

  const detail = await api(`/streams/${streamId}`);
  expect(detail.status === 'LIVE' && detail.viewerCount === 1, `detail: ${JSON.stringify(detail)}`);

  const layoutChanged = next(phone, 'stream:layout_changed');
  await api(`/streams/${streamId}/layout`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${host.accessToken}` },
    body: JSON.stringify({ layout: 'FLOATING' }),
  });
  expect((await layoutChanged).layout === 'FLOATING', 'layout change should reach viewers');

  const away = next(phone, 'stream:host_status');
  await ack(hostSocket, 'stream:host_away', { streamId, away: true });
  expect((await away).away === true, 'viewers should hear the host stepped away');
  const lateJoin = await ack(tablet, 'stream:join', { streamId });
  expect(lateJoin.hostAway === true, 'a (re)joining viewer should learn the host is away');
  await ack(hostSocket, 'stream:host_away', { streamId, away: false });
  console.log('host away/back relayed');

  const pausedEvent = next(phone, 'stream:paused');
  const pause = await ack(hostSocket, 'stream:host_pause', { streamId, paused: true });
  expect(pause.ok, `pause: ${JSON.stringify(pause)}`);
  expect((await pausedEvent).paused === true, 'viewers should hear the live was paused');
  const pausedJoin = await ack(tablet, 'stream:join', { streamId });
  expect(pausedJoin.paused === true, 'a (re)joining viewer should learn the live is paused');
  const pausedList = await api('/streams?category=Smoke-Poker');
  expect(pausedList.items.find((item) => item.id === streamId)?.paused === true, 'discovery should mark it paused');
  const viewerPause = await ack(phone, 'stream:host_pause', { streamId, paused: true });
  expect(!viewerPause.ok && viewerPause.error === 'NOT_HOST', 'only the host can pause the live');
  const resumedEvent = next(phone, 'stream:paused');
  await ack(hostSocket, 'stream:host_pause', { streamId, paused: false });
  expect((await resumedEvent).paused === false, 'viewers should hear the live resumed');
  console.log('host pause/resume relayed');

  // Chat: cleaned, posted to everyone else, answered to the sender, and a resend isn't posted twice.
  const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
  const chatArrives = next(hostSocket, 'chat:new');
  const sent = await ack(phone, 'chat:send', { streamId, text: '  gg   wp!!!!!!!!!!  ', clientId: 'smoke-1' });
  expect(sent.ok && sent.message.text === 'gg wp!!!!!', `chat send: ${JSON.stringify(sent)}`);
  const received = await chatArrives;
  expect(received.id === sent.message.id && received.sender.displayName === 'Smoke viewer', `chat:new: ${JSON.stringify(received)}`);
  const resent = await ack(phone, 'chat:send', { streamId, text: 'gg wp', clientId: 'smoke-1' });
  expect(resent.ok && resent.message.id === sent.message.id, 'a resend should return the first message');
  const empty = await ack(phone, 'chat:send', { streamId, text: ' \n ' });
  expect(!empty.ok && empty.error === 'MESSAGE_EMPTY', `empty message: ${JSON.stringify(empty)}`);

  // The host chats too. A burst of 3 passes, then the next waits for a token.
  const burst = [];
  for (let i = 0; i < 4; i++) burst.push(await ack(hostSocket, 'chat:send', { streamId, text: `burst ${i}` }));
  expect(burst.slice(0, 3).every((answer) => answer.ok), `the first three should pass: ${JSON.stringify(burst)}`);
  expect(!burst[3].ok && burst[3].error === 'RATE_LIMITED' && burst[3].retryAfterMs > 0, `the fourth should wait: ${JSON.stringify(burst[3])}`);

  const texts = (page) => page.messages.map((message) => message.text).join('|');
  const latest = await api(`/streams/${streamId}/chat?limit=3`, auth(viewer.accessToken));
  expect(texts(latest) === 'burst 0|burst 1|burst 2' && latest.hasEarlier, `latest: ${JSON.stringify(latest)}`);
  const since = await api(`/streams/${streamId}/chat?after=${sent.message.id}`, auth(viewer.accessToken));
  expect(texts(since) === 'burst 0|burst 1|burst 2' && !since.hasEarlier, `after: ${JSON.stringify(since)}`);
  const older = await api(`/streams/${streamId}/chat?before=${since.messages[0].id}`, auth(viewer.accessToken));
  expect(texts(older) === 'gg wp!!!!!' && !older.hasEarlier, `before: ${JSON.stringify(older)}`);
  console.log('chat sent, relayed, rate-limited and paged:', texts(older), '|', texts(since));

  // Likes: batched, totalled, relayed (throttled), and never from the host.
  const likesArrive = next(hostSocket, 'likes_update');
  const liked = await ack(phone, 'like:send', { streamId, count: 7 });
  expect(liked.ok && liked.total === 7, `like: ${JSON.stringify(liked)}`);
  expect((await likesArrive).total === 7, 'the room should hear the like total');
  const moreLikes = await ack(tablet, 'like:send', { streamId, count: 5 });
  expect(moreLikes.ok && moreLikes.total === 12, `more likes: ${JSON.stringify(moreLikes)}`);
  const hostLike = await ack(hostSocket, 'like:send', { streamId, count: 1 });
  expect(!hostLike.ok && hostLike.error === 'NOT_ALLOWED', 'a host cannot like their own live');
  const likedJoin = await ack(tablet, 'stream:join', { streamId });
  expect(likedJoin.likeCount === 12, `a joining viewer should see the likes: ${JSON.stringify(likedJoin)}`);
  console.log('likes totalled and relayed:', moreLikes.total);

  tablet.disconnect();
  const leftCount = await ack(phone, 'stream:join', { streamId });
  expect(leftCount.viewerCount === 1, 'the viewer is still watching on the phone');
  phone.disconnect();
  await wait(2500); // one viewer-count throttle window

  const ended = next(hostSocket, 'stream_ended');
  await api(`/streams/${streamId}/end`, { method: 'POST', headers: { Authorization: `Bearer ${host.accessToken}` } });
  const endedEvent = await ended;
  console.log('stream_ended:', endedEvent);
  expect(endedEvent.reason === 'HOST_ENDED', 'end should carry the reason');

  const endedDetail = await api(`/streams/${streamId}`);
  expect(
    endedDetail.status === 'ENDED' &&
      endedDetail.endedReason === 'HOST_ENDED' &&
      endedDetail.peakViewerCount === 1 &&
      endedDetail.likeCount === 12,
    `ended detail: ${JSON.stringify(endedDetail)}`,
  );
  const endedChat = await fetch(`${BASE_URL}/streams/${streamId}/chat`, auth(viewer.accessToken));
  expect(endedChat.status === 404, `an ended live's chat should be private, got ${endedChat.status}`);
  const joinEnded = await ack(hostSocket, 'stream:host_heartbeat', { streamId });
  expect(!joinEnded.ok && joinEnded.error === 'STREAM_NOT_LIVE', 'heartbeat for an ended live should say so');

  await api(`/streams/${quiet.stream.id}/end`, { method: 'POST', headers: { Authorization: `Bearer ${quietHost.accessToken}` } });
  hostSocket.disconnect();

  // A signed-out device's access token no longer opens a socket.
  await api('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: viewer.refreshToken }) });
  const refused = await connect(viewer.accessToken).then(
    (socket) => {
      socket.disconnect();
      return false;
    },
    (error) => error.message === 'unauthorized',
  );
  expect(refused, 'a signed-out session must not reconnect');
  console.log('signed-out session refused');

  console.log('SMOKE TEST PASSED');
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
