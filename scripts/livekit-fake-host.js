/* eslint-disable */
/**
 * A fake LiveKit host, for testing the viewer screen with a single phone:
 * goes live as a throwaway user and publishes LiveKit's demo video loop as
 * that host, so the live shows up in the app's discovery list.
 *
 * Usage: node scripts/livekit-fake-host.js
 * Requires `docker compose up -d` (LiveKit dev server) and the dev server
 * running at API_ORIGIN (.env) with VIDEO_PROVIDER=livekit.
 * Enter switches the layout (viewers follow along); q + Enter or Ctrl+C ends
 * the live.
 */
const { execFileSync, spawn } = require('child_process');
const { randomBytes } = require('crypto');
const path = require('path');
const readline = require('readline');
const { requireEnv } = require('./dev-env');

// The key pair is the one the dev LiveKit server was started with (docker-compose.yml).
const {
  API_ORIGIN,
  LIVEKIT_API_KEY: API_KEY,
  LIVEKIT_API_SECRET: API_SECRET,
} = requireEnv('API_ORIGIN', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET');
const BASE_URL = `${API_ORIGIN}/v1`;
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_IMAGE = 'livekit/livekit-cli:v2.18.8';
const LAYOUTS = ['FULL', 'FIT', 'SPLIT', 'FLOATING', 'MINIMAL'];

let tokens;

async function api(path, { method = 'GET', body, auth = true, retried = false } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && { Authorization: `Bearer ${tokens.accessToken}` }),
    },
    body: body && JSON.stringify(body),
  });
  // Access tokens last 15 minutes - longer tests renew once and retry.
  if (res.status === 401 && auth && !retried) {
    tokens = await api('/auth/refresh', { method: 'POST', body: { refreshToken: tokens.refreshToken }, auth: false });
    return api(path, { method, body, auth, retried: true });
  }
  const json = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function liveKitContainerId() {
  const id = execFileSync('docker', ['compose', 'ps', '-q', 'livekit'], { cwd: REPO_ROOT }).toString().trim();
  if (!id) throw new Error('The LiveKit dev server is not running - start it with `docker compose up -d`.');
  return id;
}

async function main() {
  const containerId = liveKitContainerId();
  const suffix = Date.now();
  tokens = await api('/auth/signup', {
    method: 'POST',
    auth: false,
    body: {
      username: `fakehost${suffix}`,
      displayName: 'Fake Host',
      email: `fakehost${suffix}@example.com`,
      // The account stays behind - never with a guessable password.
      password: `Pw-${randomBytes(12).toString('hex')}`,
    },
  });

  const { stream, rtcToken } = await api('/streams', {
    method: 'POST',
    body: { title: 'LiveKit test stream', category: 'Just Chatting' },
  });
  let ending;
  const endLive = () =>
    (ending ??= api(`/streams/${stream.id}/end`, { method: 'POST' }).then(
      () => console.log('live ended'),
      (e) => console.error('ending the live failed:', e.message),
    ));

  if (rtcToken.provider !== 'LIVEKIT') {
    await endLive();
    throw new Error(`The backend put this live on ${rtcToken.provider} - set VIDEO_PROVIDER=livekit in .env and restart it.`);
  }
  console.log(`live: "${stream.title}" (room ${stream.channelName}) - open it from the app's discovery list`);

  // Inside the LiveKit container's network, 127.0.0.1 - the address the dev
  // server advertises - is LiveKit itself.
  const publisherName = `lk-fake-host-${suffix}`;
  const publisher = spawn(
    'docker',
    [
      'run', '--rm', '--name', publisherName, '--network', `container:${containerId}`, CLI_IMAGE,
      'room', 'join', '--url', 'ws://127.0.0.1:7880', '--api-key', API_KEY, '--api-secret', API_SECRET,
      '--identity', stream.hostId, '--publish-demo', stream.channelName,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );

  let layoutIndex = LAYOUTS.indexOf(stream.layout);
  const input = readline.createInterface({ input: process.stdin });
  console.log('Enter = next layout, q + Enter (or Ctrl+C) = end the live');
  input.on('line', async (line) => {
    if (line.trim().toLowerCase() === 'q') return shutDown(0);
    layoutIndex = (layoutIndex + 1) % LAYOUTS.length;
    try {
      await api(`/streams/${stream.id}/layout`, { method: 'PATCH', body: { layout: LAYOUTS[layoutIndex] } });
      console.log(`layout -> ${LAYOUTS[layoutIndex]}`);
    } catch (e) {
      console.error('layout change failed:', e.message);
    }
  });

  // Ctrl+C also stops the docker child, so this can run twice at once.
  let shuttingDown;
  const shutDown = (code) =>
    (shuttingDown ??= (async () => {
      input.close();
      await endLive();
      try {
        execFileSync('docker', ['rm', '-f', publisherName], { stdio: 'ignore' });
      } catch {
        // Already gone: ending the live deleted the room, which disconnects it.
      }
      process.exit(code);
    })());
  process.on('SIGINT', () => shutDown(0));
  publisher.on('exit', (code) => {
    if (!ending) console.error(`the demo publisher stopped (exit code ${code})`);
    shutDown(code ?? 1);
  });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
