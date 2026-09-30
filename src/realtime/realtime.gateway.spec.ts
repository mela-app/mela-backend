import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AlertScope, AlertSeverity, RoomBanScope, StreamEndReason, StreamLayout } from '@prisma/client';
import { Server } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { WatchTicketService } from '../auth/watch-ticket.service';
import { ChatService } from '../chat/chat.service';
import { LikesService } from '../chat/likes.service';
import { LivePresenceService } from '../common/presence/live-presence.service';
import { ModeratorsService } from '../moderators/moderators.service';
import { RecordingPermissionsService } from '../recording-permissions/recording-permissions.service';
import { RoomBansService } from '../room-bans/room-bans.service';
import { RoomChatMutesService } from '../room-chat-mutes/room-chat-mutes.service';
import { StreamsService } from '../streams/streams.service';
import { RealtimeGateway } from './realtime.gateway';

const LIVE = '3f1c9a52-7c2e-4a8b-9d7e-2b6f0c1d4e5a';
const OTHER_LIVE = '8a2b7c6d-1e3f-4a5b-8c9d-0e1f2a3b4c5d';
const MESSAGE = 'a3d4e5f6-7b8c-4d1e-9f0a-1b2c3d4e5f6a';

type Middleware = (socket: FakeSocket, next: (error?: Error) => void) => void;
type EventMiddleware = (packet: unknown[], next: () => void) => void;

interface FakeSocket {
  id: string;
  data: { userId: string; viewingStreamId?: string; hostingStreamId?: string; watchOnly?: { streamId: string } };
  handshake: { auth: { token?: string; watchTicket?: string }; headers: Record<string, string> };
  rooms: Set<string>;
  join: jest.Mock;
  leave: jest.Mock;
  to: jest.Mock;
  use: jest.Mock;
}

// Broadcasts from a socket reach everyone in the room but that socket.
const othersEmit = jest.fn();

function fakeSocket(userId = 'viewer-1', id = 'socket-1'): FakeSocket {
  return {
    id,
    data: { userId },
    handshake: { auth: {}, headers: {} },
    rooms: new Set([id]),
    join: jest.fn(),
    leave: jest.fn(),
    to: jest.fn(() => ({ emit: othersEmit })),
    use: jest.fn(),
  };
}

// The share page's player without an account: its ticket is for one live.
function watchSocket(streamId = LIVE): FakeSocket {
  const socket = fakeSocket('web-anon-1', 'socket-w');
  socket.data.watchOnly = { streamId };
  return socket;
}

function inLive(socket: FakeSocket): FakeSocket {
  socket.rooms.add(`stream:${LIVE}`);
  return socket;
}

// Lets fire-and-forget work (an arrival being announced) run its course.
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('RealtimeGateway', () => {
  const jwt = { verifyAsync: jest.fn() };
  const config = { get: jest.fn(() => 'secret') };
  const auth = { isSessionActive: jest.fn() };
  const streams = { findLive: jest.fn(), participantSummaries: jest.fn() };
  const presence = {
    addViewer: jest.fn(),
    claimArrivalNotice: jest.fn(),
    removeViewer: jest.fn().mockResolvedValue(0),
    viewerCount: jest.fn().mockResolvedValue(1),
    isHostAway: jest.fn().mockResolvedValue(false),
    isPaused: jest.fn().mockResolvedValue(false),
    touchHost: jest.fn().mockResolvedValue(undefined),
    setHostAway: jest.fn().mockResolvedValue(true),
    setPaused: jest.fn().mockResolvedValue(true),
    likeCount: jest.fn().mockResolvedValue(5),
  };
  const chat = { send: jest.fn(), delete: jest.fn(), history: jest.fn() };
  const likes = { add: jest.fn() };
  const roomBans = { isBanned: jest.fn().mockResolvedValue(false) };
  const roomChatMutes = { findActive: jest.fn().mockResolvedValue(null) };
  const moderators = { listActiveUserIds: jest.fn() };
  const watchTickets = { verify: jest.fn() };
  const recordingPermissions = { isAllowed: jest.fn() };
  const roomEmit = jest.fn();
  const server = {
    to: jest.fn(() => ({ emit: roomEmit })),
    in: jest.fn(() => ({ socketsLeave: jest.fn(), disconnectSockets: jest.fn() })),
    use: jest.fn(),
  };

  function makeGateway() {
    const gateway = new RealtimeGateway(
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      auth as unknown as AuthService,
      streams as unknown as StreamsService,
      presence as unknown as LivePresenceService,
      chat as unknown as ChatService,
      likes as unknown as LikesService,
      roomBans as unknown as RoomBansService,
      roomChatMutes as unknown as RoomChatMutesService,
      moderators as unknown as ModeratorsService,
      watchTickets as unknown as WatchTicketService,
      recordingPermissions as unknown as RecordingPermissionsService,
    );
    gateway.server = server as unknown as Server;
    return gateway;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    streams.findLive.mockResolvedValue({ id: LIVE, hostId: 'host-1', layout: StreamLayout.SPLIT });
    presence.addViewer.mockResolvedValue({ viewerCount: 1, arrived: false });
    presence.claimArrivalNotice.mockResolvedValue(true);
    moderators.listActiveUserIds.mockResolvedValue(['mod-1']);
    recordingPermissions.isAllowed.mockResolvedValue(false);
  });

  describe('connection auth', () => {
    async function connect(socket: FakeSocket): Promise<Error | undefined> {
      makeGateway().afterInit(server as unknown as Server);
      const middleware = server.use.mock.calls[0][0] as Middleware;
      return new Promise((resolve) => middleware(socket, resolve));
    }

    it('accepts a token whose device session is still signed in', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', sid: 'session-1' });
      auth.isSessionActive.mockResolvedValue(true);
      const socket = fakeSocket('');
      socket.handshake.auth.token = 'token';

      await expect(connect(socket)).resolves.toBeUndefined();
      expect(socket.data.userId).toBe('user-1');
      expect(auth.isSessionActive).toHaveBeenCalledWith('session-1', 'user-1');
    });

    it('refuses a still-valid token once its session was ended (logout, suspension)', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', sid: 'session-1' });
      auth.isSessionActive.mockResolvedValue(false);
      const socket = fakeSocket('');
      socket.handshake.auth.token = 'token';

      await expect(connect(socket)).resolves.toEqual(new Error('unauthorized'));
    });

    it('refuses a missing or invalid token', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      await expect(connect(fakeSocket(''))).resolves.toEqual(new Error('unauthorized'));
    });

    it("puts every connected socket in its user's private room", () => {
      const socket = fakeSocket('user-1');

      makeGateway().handleConnection(socket as never);

      expect(socket.join).toHaveBeenCalledWith('user:user-1');
    });

    it('lets a watch ticket in as a watch-only socket for its one live, without a session', async () => {
      watchTickets.verify.mockResolvedValueOnce({ viewerId: 'web-anon-1', streamId: LIVE });
      const socket = fakeSocket('');
      socket.handshake.auth.watchTicket = 'ticket';

      await expect(connect(socket)).resolves.toBeUndefined();
      expect(socket.data).toMatchObject({ userId: 'web-anon-1', watchOnly: { streamId: LIVE } });
      expect(jwt.verifyAsync).not.toHaveBeenCalled();
      expect(auth.isSessionActive).not.toHaveBeenCalled();
    });

    it('refuses a ticket that is expired or forged', async () => {
      watchTickets.verify.mockRejectedValueOnce(new Error('invalid signature'));
      const socket = fakeSocket('');
      socket.handshake.auth.watchTicket = 'ticket';

      await expect(connect(socket)).resolves.toEqual(new Error('unauthorized'));
    });
  });

  describe('watch-only sockets (the share page player)', () => {
    function eventGuard(socket: FakeSocket): (event: string, ack?: jest.Mock) => boolean {
      makeGateway().handleConnection(socket as never);
      const middleware = socket.use.mock.calls[0][0] as EventMiddleware;
      return (event, ack) => {
        let passed = false;
        middleware(ack ? [event, { streamId: LIVE }, ack] : [event, { streamId: LIVE }], () => (passed = true));
        return passed;
      };
    }

    it('get no private room, and may only watch or leave - anything else is refused', () => {
      const socket = watchSocket();
      const allows = eventGuard(socket);
      const ack = jest.fn();

      expect(socket.join).not.toHaveBeenCalled();
      expect(allows('stream:watch')).toBe(true);
      expect(allows('stream:leave')).toBe(true);
      for (const event of ['stream:join', 'chat:send', 'like:send', 'chat:delete', 'stream:host_join']) {
        expect(allows(event, ack)).toBe(false);
      }
      expect(ack).toHaveBeenLastCalledWith({ ok: false, error: 'NOT_ALLOWED' });
    });

    it("follow their live's room, counted as a viewer but never announced, with the chat so far", async () => {
      const message = { id: MESSAGE, text: 'hi' };
      chat.history.mockResolvedValueOnce({ messages: [message], hasEarlier: false });
      const socket = watchSocket();

      const ack = await makeGateway().onStreamWatch(socket as never, { streamId: LIVE });

      expect(ack).toEqual({
        ok: true,
        viewerCount: 1,
        layout: StreamLayout.SPLIT,
        hostAway: false,
        paused: false,
        likeCount: 5,
        moderatorIds: ['mod-1'],
        messages: [message],
      });
      expect(socket.join).toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(presence.addViewer).toHaveBeenCalledWith(LIVE, 'web-anon-1', 'socket-w');
      expect(presence.claimArrivalNotice).not.toHaveBeenCalled();
      expect(chat.history).toHaveBeenCalledWith(LIVE, { limit: 30 });
    });

    it('are held to the live their ticket is for', async () => {
      const ack = await makeGateway().onStreamWatch(watchSocket(OTHER_LIVE) as never, { streamId: LIVE });

      expect(ack).toEqual({ ok: false, error: 'NOT_ALLOWED' });
      expect(streams.findLive).not.toHaveBeenCalled();
    });

    it('find nothing to watch once the live is over', async () => {
      streams.findLive.mockResolvedValue(null);

      const ack = await makeGateway().onStreamWatch(watchSocket() as never, { streamId: LIVE });

      expect(ack).toEqual({ ok: false, error: 'STREAM_NOT_LIVE' });
    });

    it('is no way in for a signed-in socket - that one joins', async () => {
      const ack = await makeGateway().onStreamWatch(fakeSocket() as never, { streamId: LIVE });

      expect(ack).toEqual({ ok: false, error: 'NOT_ALLOWED' });
    });
  });

  describe('viewers', () => {
    it('joins a live, counts the viewer, and acknowledges the room state', async () => {
      const socket = fakeSocket();

      const ack = await makeGateway().onStreamJoin(socket as never, { streamId: LIVE });

      expect(ack).toEqual({
        ok: true,
        viewerCount: 1,
        layout: StreamLayout.SPLIT,
        hostAway: false,
        paused: false,
        likeCount: 5,
        moderatorIds: ['mod-1'],
        chatMuted: false,
        chatMutedUntil: null,
        canRecord: false,
      });
      expect(socket.join).toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(presence.addViewer).toHaveBeenCalledWith(LIVE, 'viewer-1', 'socket-1');
    });

    it('tells a joiner the host lets them record, so a reconnect catches up on it', async () => {
      recordingPermissions.isAllowed.mockResolvedValueOnce(true);

      const ack = await makeGateway().onStreamJoin(fakeSocket() as never, { streamId: LIVE });

      expect(ack).toMatchObject({ ok: true, canRecord: true });
      expect(recordingPermissions.isAllowed).toHaveBeenCalledWith(LIVE, 'viewer-1');
    });

    it("tells a joiner about their own chat mute, so a reconnect catches up on one it missed", async () => {
      const until = new Date('2026-09-27T12:05:00Z');
      roomChatMutes.findActive.mockResolvedValueOnce({ expiresAt: until });

      const ack = await makeGateway().onStreamJoin(fakeSocket() as never, { streamId: LIVE });

      expect(ack).toMatchObject({ ok: true, chatMuted: true, chatMutedUntil: until });
      expect(roomChatMutes.findActive).toHaveBeenCalledWith(LIVE, 'viewer-1');
    });

    it('tells a viewer joining a paused live', async () => {
      presence.isPaused.mockResolvedValueOnce(true);

      const ack = await makeGateway().onStreamJoin(fakeSocket() as never, { streamId: LIVE });

      expect(ack).toMatchObject({ ok: true, paused: true });
    });

    it('rejects a malformed request', async () => {
      const gateway = makeGateway();

      await expect(
        gateway.onStreamJoin(fakeSocket() as never, { streamId: 'not-a-uuid' }),
      ).resolves.toEqual({
        ok: false,
        error: 'INVALID_PAYLOAD',
      });
      await expect(gateway.onStreamJoin(fakeSocket() as never, null)).resolves.toMatchObject({
        ok: false,
      });
      expect(streams.findLive).not.toHaveBeenCalled();
    });

    it('rejects a live that is over', async () => {
      streams.findLive.mockResolvedValue(null);
      const socket = fakeSocket();

      await expect(
        makeGateway().onStreamJoin(socket as never, { streamId: LIVE }),
      ).resolves.toEqual({
        ok: false,
        error: 'STREAM_NOT_LIVE',
      });
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('rejects a viewer banned from this host', async () => {
      roomBans.isBanned.mockResolvedValueOnce(true);
      const socket = fakeSocket();

      await expect(
        makeGateway().onStreamJoin(socket as never, { streamId: LIVE }),
      ).resolves.toEqual({
        ok: false,
        error: 'NOT_ALLOWED',
      });
      expect(roomBans.isBanned).toHaveBeenCalledWith('host-1', 'viewer-1', LIVE);
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('leaves the previous live when a socket joins another', async () => {
      const socket = fakeSocket();
      const gateway = makeGateway();
      await gateway.onStreamJoin(socket as never, { streamId: LIVE });
      streams.findLive.mockResolvedValue({
        id: OTHER_LIVE,
        hostId: 'host-2',
        layout: StreamLayout.FULL,
      });

      await gateway.onStreamJoin(socket as never, { streamId: OTHER_LIVE });

      expect(socket.leave).toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(presence.removeViewer).toHaveBeenCalledWith(LIVE, 'socket-1');
      expect(socket.data.viewingStreamId).toBe(OTHER_LIVE);
    });

    it("doesn't count the host watching their own live", async () => {
      const socket = fakeSocket('host-1');

      await makeGateway().onStreamJoin(socket as never, { streamId: LIVE });

      expect(presence.addViewer).not.toHaveBeenCalled();
      expect(socket.join).toHaveBeenCalledWith(`stream:${LIVE}`);
    });

    it('stops counting a viewer who disconnects', async () => {
      const socket = fakeSocket();
      const gateway = makeGateway();
      await gateway.onStreamJoin(socket as never, { streamId: LIVE });

      await gateway.handleDisconnect(socket as never);

      expect(presence.removeViewer).toHaveBeenCalledWith(LIVE, 'socket-1');
      expect(socket.data.viewingStreamId).toBeUndefined();
    });
  });

  describe('arrivals', () => {
    const person = (id: string) => ({ id, username: id, displayName: id.toUpperCase(), avatarUrl: null });

    beforeEach(() => {
      streams.participantSummaries.mockImplementation((ids: string[]) => Promise.resolve(ids.map(person)));
    });

    it("announces someone's first arrival in a live to its room", async () => {
      presence.addViewer.mockResolvedValueOnce({ viewerCount: 2, arrived: true });

      await makeGateway().onStreamJoin(fakeSocket('kebede') as never, { streamId: LIVE });
      await settle();

      expect(presence.claimArrivalNotice).toHaveBeenCalledWith(LIVE, 'kebede');
      expect(server.to).toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(roomEmit).toHaveBeenCalledWith('viewer:joined', { streamId: LIVE, user: person('kebede'), others: 0 });
    });

    it('stays quiet for another device or a reconnect, and for someone announced recently', async () => {
      const gateway = makeGateway();
      await gateway.onStreamJoin(fakeSocket('kebede') as never, { streamId: LIVE });
      presence.addViewer.mockResolvedValueOnce({ viewerCount: 2, arrived: true });
      presence.claimArrivalNotice.mockResolvedValueOnce(false);
      await gateway.onStreamJoin(fakeSocket('almaz', 'socket-2') as never, { streamId: LIVE });
      await settle();

      expect(presence.claimArrivalNotice).toHaveBeenCalledTimes(1);
      expect(streams.participantSummaries).not.toHaveBeenCalled();
      expect(roomEmit).not.toHaveBeenCalledWith('viewer:joined', expect.anything());
    });

    it('rolls a burst into one notice at a time: the latest arrival, and how many came with them', async () => {
      const notices = () => roomEmit.mock.calls.filter(([event]) => event === 'viewer:joined').map(([, body]) => body);
      jest.useFakeTimers();
      try {
        const gateway = makeGateway();
        for (const [index, userId] of ['a', 'b', 'c'].entries()) {
          presence.addViewer.mockResolvedValueOnce({ viewerCount: index + 1, arrived: true });
          await gateway.onStreamJoin(fakeSocket(userId, `socket-${userId}`) as never, { streamId: LIVE });
          await settle();
        }
        expect(notices()).toEqual([{ streamId: LIVE, user: person('a'), others: 0 }]);

        jest.advanceTimersByTime(1500);
        await settle();

        expect(notices()).toEqual([
          { streamId: LIVE, user: person('a'), others: 0 },
          { streamId: LIVE, user: person('c'), others: 1 },
        ]);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('host', () => {
    it('lets the host join their live and counts it as a heartbeat', async () => {
      const socket = fakeSocket('host-1');

      const ack = await makeGateway().onHostJoin(socket as never, { streamId: LIVE });

      expect(ack).toMatchObject({ ok: true, viewerCount: 1 });
      expect(socket.data.hostingStreamId).toBe(LIVE);
      expect(presence.touchHost).toHaveBeenCalledWith(LIVE);
      // Joining from the foreground means they're back.
      expect(presence.setHostAway).toHaveBeenCalledWith(LIVE, false);
    });

    it('keeps the host away when their app rejoins from the background', async () => {
      await makeGateway().onHostJoin(fakeSocket('host-1') as never, { streamId: LIVE, away: true });

      expect(presence.setHostAway).toHaveBeenCalledWith(LIVE, true);
    });

    it('refuses anyone else joining as host', async () => {
      const socket = fakeSocket('viewer-1');

      await expect(makeGateway().onHostJoin(socket as never, { streamId: LIVE })).resolves.toEqual({
        ok: false,
        error: 'NOT_HOST',
      });
      expect(presence.touchHost).not.toHaveBeenCalled();
    });

    it('refreshes the heartbeat while the live is on', async () => {
      const socket = fakeSocket('host-1');
      socket.data.hostingStreamId = LIVE;

      await expect(
        makeGateway().onHostHeartbeat(socket as never, { streamId: LIVE }),
      ).resolves.toEqual({ ok: true });
      expect(presence.touchHost).toHaveBeenCalledWith(LIVE);
    });

    it('tells a host whose live was ended meanwhile', async () => {
      const socket = fakeSocket('host-1');
      socket.data.hostingStreamId = LIVE;
      streams.findLive.mockResolvedValue(null);

      await expect(
        makeGateway().onHostHeartbeat(socket as never, { streamId: LIVE }),
      ).resolves.toEqual({
        ok: false,
        error: 'STREAM_NOT_LIVE',
      });
      expect(presence.touchHost).not.toHaveBeenCalled();
      expect(socket.data.hostingStreamId).toBeUndefined();
    });

    it("ignores a heartbeat for a live the socket doesn't host", async () => {
      await expect(
        makeGateway().onHostHeartbeat(fakeSocket('host-1') as never, { streamId: LIVE }),
      ).resolves.toEqual({
        ok: false,
        error: 'NOT_HOST',
      });
    });

    it('tells viewers when the host steps away, once', async () => {
      const socket = fakeSocket('host-1');
      socket.data.hostingStreamId = LIVE;
      const gateway = makeGateway();

      await gateway.onHostAway(socket as never, { streamId: LIVE, away: true });
      presence.setHostAway.mockResolvedValueOnce(false);
      await gateway.onHostAway(socket as never, { streamId: LIVE, away: true });

      expect(presence.setHostAway).toHaveBeenCalledWith(LIVE, true);
      expect(roomEmit).toHaveBeenCalledTimes(1);
      expect(roomEmit).toHaveBeenCalledWith('stream:host_status', { streamId: LIVE, away: true });
      // Stepping away isn't a sign of life.
      expect(presence.touchHost).not.toHaveBeenCalled();
    });

    it('counts the host coming back as a heartbeat', async () => {
      const socket = fakeSocket('host-1');
      socket.data.hostingStreamId = LIVE;

      await expect(
        makeGateway().onHostAway(socket as never, { streamId: LIVE, away: false }),
      ).resolves.toEqual({ ok: true });

      expect(presence.touchHost).toHaveBeenCalledWith(LIVE);
      expect(presence.setHostAway).toHaveBeenCalledWith(LIVE, false);
    });

    it('tells a host coming back that their live was ended meanwhile', async () => {
      const socket = fakeSocket('host-1');
      socket.data.hostingStreamId = LIVE;
      streams.findLive.mockResolvedValue(null);

      await expect(
        makeGateway().onHostAway(socket as never, { streamId: LIVE, away: false }),
      ).resolves.toEqual({ ok: false, error: 'STREAM_NOT_LIVE' });

      expect(presence.touchHost).not.toHaveBeenCalled();
      expect(presence.setHostAway).not.toHaveBeenCalled();
      expect(socket.data.hostingStreamId).toBeUndefined();
    });

    it('pauses the live for viewers, once, and re-arms the heartbeat for the pause', async () => {
      const socket = fakeSocket('host-1');
      socket.data.hostingStreamId = LIVE;
      const gateway = makeGateway();

      await expect(
        gateway.onHostPause(socket as never, { streamId: LIVE, paused: true }),
      ).resolves.toEqual({ ok: true });
      presence.setPaused.mockResolvedValueOnce(false);
      await gateway.onHostPause(socket as never, { streamId: LIVE, paused: true });

      expect(presence.setPaused).toHaveBeenCalledWith(LIVE, true);
      expect(roomEmit).toHaveBeenCalledTimes(1);
      expect(roomEmit).toHaveBeenCalledWith('stream:paused', { streamId: LIVE, paused: true });
      // After the flag, so the heartbeat gets the paused grace window.
      expect(presence.touchHost.mock.invocationCallOrder[0]).toBeGreaterThan(
        presence.setPaused.mock.invocationCallOrder[0],
      );
    });

    it('refuses a pause from anyone but the host', async () => {
      await expect(
        makeGateway().onHostPause(fakeSocket('viewer-1') as never, {
          streamId: LIVE,
          paused: true,
        }),
      ).resolves.toEqual({ ok: false, error: 'NOT_HOST' });
      expect(presence.setPaused).not.toHaveBeenCalled();
    });

    it('tells a host pausing a live that already ended', async () => {
      const socket = fakeSocket('host-1');
      socket.data.hostingStreamId = LIVE;
      streams.findLive.mockResolvedValue(null);

      await expect(
        makeGateway().onHostPause(socket as never, { streamId: LIVE, paused: false }),
      ).resolves.toEqual({ ok: false, error: 'STREAM_NOT_LIVE' });
      expect(presence.setPaused).not.toHaveBeenCalled();
      expect(socket.data.hostingStreamId).toBeUndefined();
    });

    it('restores the pause when the host rejoins, before the heartbeat', async () => {
      await makeGateway().onHostJoin(fakeSocket('host-1') as never, {
        streamId: LIVE,
        paused: true,
      });

      expect(presence.setPaused).toHaveBeenCalledWith(LIVE, true);
      expect(presence.touchHost.mock.invocationCallOrder[0]).toBeGreaterThan(
        presence.setPaused.mock.invocationCallOrder[0],
      );
    });

    it('leaves the pause alone when an app that never pauses rejoins', async () => {
      await makeGateway().onHostJoin(fakeSocket('host-1') as never, { streamId: LIVE });

      expect(presence.setPaused).not.toHaveBeenCalled();
    });
  });

  describe('chat', () => {
    const message = {
      id: 'm1',
      streamId: LIVE,
      text: 'gg',
      createdAt: new Date(),
      sender: { id: 'viewer-1', displayName: 'Ana' },
    };

    it('posts to everyone else in the live and hands the sender their message', async () => {
      chat.send.mockResolvedValue({ ok: true, message, resent: false });
      const socket = inLive(fakeSocket());

      const ack = await makeGateway().onChatSend(socket as never, {
        streamId: LIVE,
        text: 'gg',
        clientId: 'c1',
      });

      expect(ack).toEqual({ ok: true, message });
      expect(chat.send).toHaveBeenCalledWith(LIVE, 'viewer-1', 'gg', 'c1', undefined);
      expect(socket.to).toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(othersEmit).toHaveBeenCalledWith('chat:new', message);
    });

    it('passes a photo on to the chat pipeline, which decides who may post one', async () => {
      chat.send.mockResolvedValue({ ok: true, message, resent: false });
      const key = `chat-images/${LIVE}/5f0c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c.jpg`;

      await makeGateway().onChatSend(inLive(fakeSocket('host-1')) as never, {
        streamId: LIVE,
        clientId: 'c2',
        imageKey: key,
      });

      expect(chat.send).toHaveBeenCalledWith(LIVE, 'host-1', '', 'c2', key);
    });

    it("doesn't post a resent message twice", async () => {
      chat.send.mockResolvedValue({ ok: true, message, resent: true });

      const ack = await makeGateway().onChatSend(inLive(fakeSocket()) as never, {
        streamId: LIVE,
        text: 'gg',
        clientId: 'c1',
      });

      expect(ack).toEqual({ ok: true, message });
      expect(othersEmit).not.toHaveBeenCalled();
    });

    it('refuses chat from outside the live - including one that has ended', async () => {
      const ack = await makeGateway().onChatSend(fakeSocket() as never, {
        streamId: LIVE,
        text: 'hi',
      });

      expect(ack).toEqual({ ok: false, error: 'NOT_IN_ROOM' });
      expect(chat.send).not.toHaveBeenCalled();
    });

    it('passes the reason on, with when to try again', async () => {
      chat.send.mockResolvedValue({ ok: false, error: 'RATE_LIMITED', retryAfterMs: 900 });

      await expect(
        makeGateway().onChatSend(inLive(fakeSocket()) as never, { streamId: LIVE, text: 'x' }),
      ).resolves.toEqual({ ok: false, error: 'RATE_LIMITED', retryAfterMs: 900 });
    });

    it('answers UNAVAILABLE instead of leaving the app waiting when saving fails', async () => {
      chat.send.mockRejectedValue(new Error('db down'));

      await expect(
        makeGateway().onChatSend(inLive(fakeSocket()) as never, { streamId: LIVE, text: 'x' }),
      ).resolves.toEqual({ ok: false, error: 'UNAVAILABLE' });
    });

    it('rejects a malformed message', async () => {
      await expect(
        makeGateway().onChatSend(inLive(fakeSocket()) as never, { streamId: LIVE, text: 42 }),
      ).resolves.toEqual({ ok: false, error: 'INVALID_PAYLOAD' });
    });
  });

  describe('chat delete', () => {
    it('deletes and lets the chat_message.deleted event handle the broadcast', async () => {
      chat.delete.mockResolvedValue({ ok: true });
      const socket = inLive(fakeSocket());

      const ack = await makeGateway().onChatDelete(socket as never, { streamId: LIVE, messageId: MESSAGE });

      expect(ack).toEqual({ ok: true });
      expect(chat.delete).toHaveBeenCalledWith(LIVE, MESSAGE, 'viewer-1');
      expect(server.to).not.toHaveBeenCalled();
    });

    it('refuses a delete from outside the live', async () => {
      const ack = await makeGateway().onChatDelete(fakeSocket() as never, { streamId: LIVE, messageId: MESSAGE });

      expect(ack).toEqual({ ok: false, error: 'NOT_IN_ROOM' });
      expect(chat.delete).not.toHaveBeenCalled();
    });

    it("passes on the service's refusal (not the sender, not the host)", async () => {
      chat.delete.mockResolvedValue({ ok: false, error: 'NOT_FOUND' });

      await expect(
        makeGateway().onChatDelete(inLive(fakeSocket()) as never, { streamId: LIVE, messageId: MESSAGE }),
      ).resolves.toEqual({ ok: false, error: 'NOT_FOUND' });
      expect(roomEmit).not.toHaveBeenCalled();
    });

    it('answers UNAVAILABLE instead of leaving the app waiting when deleting fails', async () => {
      chat.delete.mockRejectedValue(new Error('db down'));

      await expect(
        makeGateway().onChatDelete(inLive(fakeSocket()) as never, { streamId: LIVE, messageId: MESSAGE }),
      ).resolves.toEqual({ ok: false, error: 'UNAVAILABLE' });
    });

    it('rejects a malformed payload', async () => {
      await expect(
        makeGateway().onChatDelete(inLive(fakeSocket()) as never, { streamId: LIVE, messageId: 42 }),
      ).resolves.toEqual({ ok: false, error: 'INVALID_PAYLOAD' });
    });
  });

  describe('likes', () => {
    it("adds a viewer's batch and tells the room the new total", async () => {
      likes.add.mockResolvedValue({ ok: true, total: 12 });
      presence.likeCount.mockResolvedValueOnce(12);

      const ack = await makeGateway().onLikeSend(inLive(fakeSocket()) as never, {
        streamId: LIVE,
        count: 4,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(ack).toEqual({ ok: true, total: 12 });
      expect(likes.add).toHaveBeenCalledWith(LIVE, 'viewer-1', 4);
      expect(roomEmit).toHaveBeenCalledWith('likes_update', { streamId: LIVE, total: 12 });
    });

    it("doesn't count a host liking their own live", async () => {
      const host = inLive(fakeSocket('host-1'));
      host.data.hostingStreamId = LIVE;

      await expect(
        makeGateway().onLikeSend(host as never, { streamId: LIVE, count: 1 }),
      ).resolves.toEqual({ ok: false, error: 'NOT_ALLOWED' });
      expect(likes.add).not.toHaveBeenCalled();
    });

    it('refuses likes from outside the live, and oversized batches', async () => {
      const gateway = makeGateway();

      await expect(
        gateway.onLikeSend(fakeSocket() as never, { streamId: LIVE, count: 1 }),
      ).resolves.toEqual({ ok: false, error: 'NOT_IN_ROOM' });
      await expect(
        gateway.onLikeSend(inLive(fakeSocket()) as never, { streamId: LIVE, count: 500 }),
      ).resolves.toEqual({ ok: false, error: 'INVALID_PAYLOAD' });
      expect(likes.add).not.toHaveBeenCalled();
    });

    it('passes a rate limit on with when to try again', async () => {
      likes.add.mockResolvedValue({ ok: false, error: 'RATE_LIMITED', retryAfterMs: 300 });

      await expect(
        makeGateway().onLikeSend(inLive(fakeSocket()) as never, { streamId: LIVE, count: 2 }),
      ).resolves.toEqual({ ok: false, error: 'RATE_LIMITED', retryAfterMs: 300 });
      expect(roomEmit).not.toHaveBeenCalled();
    });
  });

  it('announces the end with its reason and empties the room', () => {
    const socketsLeave = jest.fn();
    server.in.mockReturnValueOnce({ socketsLeave, disconnectSockets: jest.fn() });

    makeGateway().handleStreamEnded({ streamId: LIVE, reason: StreamEndReason.HOST_DISCONNECTED });

    expect(roomEmit).toHaveBeenCalledWith('stream_ended', {
      streamId: LIVE,
      reason: 'HOST_DISCONNECTED',
    });
    expect(socketsLeave).toHaveBeenCalledWith(`stream:${LIVE}`);
  });

  it("disconnects a suspended user's sockets", () => {
    const disconnectSockets = jest.fn();
    server.in.mockReturnValueOnce({ socketsLeave: jest.fn(), disconnectSockets });

    makeGateway().handleUserSuspended({ userId: 'user-1', suspendedBy: 'admin-1' });

    expect(server.in).toHaveBeenCalledWith('user:user-1');
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('broadcasts a chat delete to the room once the domain event fires', () => {
    makeGateway().handleChatMessageDeleted({ streamId: LIVE, messageId: MESSAGE, actorId: 'host-1' });

    expect(server.to).toHaveBeenCalledWith(`stream:${LIVE}`);
    expect(roomEmit).toHaveBeenCalledWith('chat:deleted', { streamId: LIVE, messageId: MESSAGE });
  });

  it('broadcasts a pinned message to the room', () => {
    const payload = { streamId: LIVE, messageId: MESSAGE, actorId: 'host-1', text: 'hi', senderName: 'Ann' };

    makeGateway().handleChatMessagePinned(payload);

    expect(roomEmit).toHaveBeenCalledWith('chat:pinned', payload);
  });

  it('broadcasts an unpinned message to the room', () => {
    const payload = { streamId: LIVE, actorId: 'host-1' };

    makeGateway().handleChatMessageUnpinned(payload);

    expect(roomEmit).toHaveBeenCalledWith('chat:unpinned', payload);
  });

  it("tells the new moderator's own sockets about a grant, and the room who moderates now", async () => {
    const payload = { hostId: 'host-1', streamId: LIVE, userId: 'mod-1', capabilities: ['DELETE_MESSAGES'] as never };

    makeGateway().handleModeratorGranted(payload);
    await settle();

    expect(server.to).toHaveBeenCalledWith('user:mod-1');
    expect(roomEmit).toHaveBeenCalledWith('moderator:granted', payload);
    expect(server.to).toHaveBeenCalledWith(`stream:${LIVE}`);
    expect(roomEmit).toHaveBeenCalledWith('stream:moderators', { streamId: LIVE, moderatorIds: ['mod-1'] });
  });

  it("tells only the moderator's own sockets about a capability update", async () => {
    const payload = { streamId: LIVE, userId: 'mod-1', capabilities: ['PIN_MESSAGES'] as never };

    makeGateway().handleModeratorUpdated(payload);
    await settle();

    expect(roomEmit).toHaveBeenCalledWith('moderator:updated', payload);
    expect(moderators.listActiveUserIds).not.toHaveBeenCalled();
  });

  it("tells the moderator's own sockets about a revoke, and the room who's left", async () => {
    const payload = { streamId: LIVE, userId: 'mod-1' };
    moderators.listActiveUserIds.mockResolvedValueOnce([]);

    makeGateway().handleModeratorRevoked(payload);
    await settle();

    expect(server.to).toHaveBeenCalledWith('user:mod-1');
    expect(roomEmit).toHaveBeenCalledWith('moderator:revoked', payload);
    expect(roomEmit).toHaveBeenCalledWith('stream:moderators', { streamId: LIVE, moderatorIds: [] });
  });

  describe('notification created', () => {
    it("relays a new notification and a +1 unread delta to the recipient's own room only", () => {
      const notification = {
        id: 'n1',
        type: 'NEW_FOLLOWER' as never,
        actorId: 'u2',
        streamId: null,
        createdAt: new Date('2026-01-01'),
        actor: { id: 'u2', username: 'kebede', displayName: 'Kebede', avatarUrl: null },
        streamTitle: null,
      };

      makeGateway().handleNotificationCreated({ recipientId: 'u1', notification });

      expect(server.to).toHaveBeenCalledWith('user:u1');
      expect(roomEmit).toHaveBeenCalledWith('notification:new', notification);
      expect(roomEmit).toHaveBeenCalledWith('notification:unread_count', { delta: 1 });
    });
  });

  describe('guest management', () => {
    const user = { id: 'g1', username: 'guest', displayName: 'Guest', avatarUrl: null };

    it('sends a new request or invite privately to each recipient the emitter computed', () => {
      const payload = { streamId: LIVE, requestId: 'req-1', initiatedBy: 'VIEWER' as never, user, recipientIds: ['host-1', 'mod-1'] };

      makeGateway().handleGuestRequestCreated(payload);

      expect(server.to).toHaveBeenCalledWith('user:host-1');
      expect(server.to).toHaveBeenCalledWith('user:mod-1');
      expect(server.to).not.toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(roomEmit).toHaveBeenCalledTimes(2);
      expect(roomEmit).toHaveBeenCalledWith('guest_request:new', payload);
    });

    it("sends an acceptance (with its publish credentials) only to the new guest's own sockets", () => {
      const payload = {
        streamId: LIVE,
        requestId: 'req-1',
        userId: 'g1',
        credentials: { provider: 'LIVEKIT' as const, url: 'wss://lk', token: 't', expiresAt: new Date() },
      };

      makeGateway().handleGuestRequestAccepted(payload);

      expect(server.to).toHaveBeenCalledTimes(1);
      expect(server.to).toHaveBeenCalledWith('user:g1');
      expect(roomEmit).toHaveBeenCalledWith('guest_request:accepted', payload);
    });

    it('sends a rejection only to the requester', () => {
      const payload = { streamId: LIVE, requestId: 'req-1', userId: 'g1' };

      makeGateway().handleGuestRequestRejected(payload);

      expect(server.to).toHaveBeenCalledWith('user:g1');
      expect(roomEmit).toHaveBeenCalledWith('guest_request:rejected', payload);
    });

    it('sends a cancellation to each recipient of the original request', () => {
      const payload = { streamId: LIVE, requestId: 'req-1', initiatedBy: 'HOST' as never, recipientIds: ['g1'] };

      makeGateway().handleGuestRequestCancelled(payload);

      expect(server.to).toHaveBeenCalledWith('user:g1');
      expect(roomEmit).toHaveBeenCalledWith('guest_request:cancelled', payload);
    });

    it('announces a new guest to the whole stream room', () => {
      const payload = { streamId: LIVE, user, agoraUid: 42 };

      makeGateway().handleGuestJoined(payload);

      expect(server.to).toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(roomEmit).toHaveBeenCalledWith('guest:joined', payload);
    });

    it('announces a removal to the room and tells the removed guest privately', () => {
      const payload = { streamId: LIVE, hostId: 'host-1', userId: 'g1', wasRemovedByHostOrModerator: true };

      makeGateway().handleGuestRemoved(payload);

      expect(server.to).toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(roomEmit).toHaveBeenCalledWith('guest:removed', payload);
      expect(server.to).toHaveBeenCalledWith('user:g1');
      expect(roomEmit).toHaveBeenCalledWith('you_were_removed', { streamId: LIVE, hostId: 'host-1' });
    });

    it('does not privately notify a guest who left on their own', () => {
      const payload = { streamId: LIVE, hostId: 'host-1', userId: 'g1', wasRemovedByHostOrModerator: false };

      makeGateway().handleGuestRemoved(payload);

      expect(server.to).not.toHaveBeenCalledWith('user:g1');
      expect(roomEmit).not.toHaveBeenCalledWith('you_were_removed', expect.anything());
    });
  });

  describe('mute suite', () => {
    it('tells only the muted person about a chat mute - the room never learns', () => {
      const until = new Date('2026-09-27T12:05:00Z');

      makeGateway().handleRoomChatMuteChanged({
        streamId: LIVE,
        userId: 'troll-1',
        actorId: 'mod-1',
        muted: true,
        mutedUntil: until,
      });

      expect(server.to).toHaveBeenCalledTimes(1);
      expect(server.to).toHaveBeenCalledWith('user:troll-1');
      expect(roomEmit).toHaveBeenCalledWith('chat:muted', { streamId: LIVE, mutedUntil: until });
    });

    it('tells the muted person when their chat mute is lifted', () => {
      makeGateway().handleRoomChatMuteChanged({
        streamId: LIVE,
        userId: 'troll-1',
        actorId: 'host-1',
        muted: false,
        mutedUntil: null,
      });

      expect(server.to).toHaveBeenCalledWith('user:troll-1');
      expect(roomEmit).toHaveBeenCalledWith('chat:unmuted', { streamId: LIVE });
    });

    it("tells the guest to turn their mic off and shows everyone it's muted", () => {
      makeGateway().handleGuestMicForceMuteChanged({ streamId: LIVE, userId: 'g1', actorId: 'host-1', forceMuted: true });

      expect(server.to).toHaveBeenCalledWith('user:g1');
      expect(roomEmit).toHaveBeenCalledWith('force_mute_audio', { streamId: LIVE });
      expect(server.to).toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(roomEmit).toHaveBeenCalledWith('presence:audio_state', { streamId: LIVE, userId: 'g1', forceMuted: true });
    });

    it('only updates everyone when the mic is allowed again - never turns it on', () => {
      makeGateway().handleGuestMicForceMuteChanged({ streamId: LIVE, userId: 'g1', actorId: 'host-1', forceMuted: false });

      expect(server.to).not.toHaveBeenCalledWith('user:g1');
      expect(roomEmit).toHaveBeenCalledTimes(1);
      expect(roomEmit).toHaveBeenCalledWith('presence:audio_state', { streamId: LIVE, userId: 'g1', forceMuted: false });
    });
  });

  describe('recording permission', () => {
    it('tells only that viewer when the host lets them record, or takes it back', () => {
      const gateway = makeGateway();

      gateway.handleRecordingPermissionChanged({ streamId: LIVE, userId: 'fan-1', actorId: 'host-1', allowed: true });
      gateway.handleRecordingPermissionChanged({ streamId: LIVE, userId: 'fan-1', actorId: 'host-1', allowed: false });

      expect(server.to.mock.calls).toEqual([['user:fan-1'], ['user:fan-1']]);
      expect(roomEmit.mock.calls).toEqual([
        ['recording:permission', { streamId: LIVE, allowed: true }],
        ['recording:permission', { streamId: LIVE, allowed: false }],
      ]);
    });
  });

  describe('room ban created', () => {
    it('evicts the banned user from the specific stream room for a session ban', () => {
      const socketsLeave = jest.fn();
      server.in.mockReturnValueOnce({ socketsLeave, disconnectSockets: jest.fn() });

      makeGateway().handleRoomBanCreated({
        hostId: 'host-1',
        bannedUserId: 'troll-1',
        streamId: LIVE,
        scope: RoomBanScope.SESSION,
      });

      expect(server.in).toHaveBeenCalledWith('user:troll-1');
      expect(socketsLeave).toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(server.to).toHaveBeenCalledWith('user:troll-1');
      expect(roomEmit).toHaveBeenCalledWith('force_disconnect', {
        hostId: 'host-1',
        streamId: LIVE,
        scope: RoomBanScope.SESSION,
      });
    });

    it('skips the room eviction for a permanent ban with no specific room, but still notifies', () => {
      makeGateway().handleRoomBanCreated({
        hostId: 'host-1',
        bannedUserId: 'troll-1',
        streamId: null,
        scope: RoomBanScope.HOST_PERMANENT,
      });

      expect(server.in).not.toHaveBeenCalled();
      expect(roomEmit).toHaveBeenCalledWith('force_disconnect', {
        hostId: 'host-1',
        streamId: null,
        scope: RoomBanScope.HOST_PERMANENT,
      });
    });
  });

  describe('admin console (plan §6.8)', () => {
    it('tells everyone in a locked live why, in its own event', () => {
      makeGateway().handleStreamLocked({
        streamId: LIVE,
        hostId: 'host-1',
        actorId: 'admin-1',
        reason: 'Graphic violence',
      });

      expect(server.to).toHaveBeenCalledWith(`stream:${LIVE}`);
      // Who locked it stays in the console.
      expect(roomEmit).toHaveBeenCalledWith('stream:locked', { streamId: LIVE, reason: 'Graphic violence' });
    });

    it('tells only the host that a locked live was unlocked', () => {
      makeGateway().handleStreamUnlocked({ streamId: LIVE, actorId: 'admin-1', hostId: 'host-1' });

      expect(server.to).toHaveBeenCalledTimes(1);
      expect(server.to).toHaveBeenCalledWith('user:host-1');
      expect(roomEmit).toHaveBeenCalledWith('stream:unlocked', { streamId: LIVE });
    });

    it('sends a stream alert to that live only', () => {
      const createdAt = new Date();
      makeGateway().handleAdminAlertSent({
        alertId: 'alert-1',
        actorId: 'admin-1',
        scope: AlertScope.STREAM,
        streamId: LIVE,
        message: 'Keep it civil',
        severity: AlertSeverity.WARNING,
        createdAt,
      });

      expect(server.to).toHaveBeenCalledWith(`stream:${LIVE}`);
      expect(roomEmit).toHaveBeenCalledWith('admin:alert', {
        id: 'alert-1',
        scope: AlertScope.STREAM,
        streamId: LIVE,
        message: 'Keep it civil',
        severity: AlertSeverity.WARNING,
        createdAt,
      });
    });

    it('sends a global alert to every connected app', () => {
      const emit = jest.fn();
      const gateway = makeGateway();
      gateway.server = { ...server, emit } as unknown as Server;

      gateway.handleAdminAlertSent({
        alertId: 'alert-2',
        actorId: 'admin-1',
        scope: AlertScope.GLOBAL,
        streamId: null,
        message: 'Maintenance tonight',
        severity: AlertSeverity.INFO,
        createdAt: new Date(),
      });

      expect(server.to).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledWith('admin:alert', expect.objectContaining({ id: 'alert-2', scope: 'GLOBAL' }));
    });

    it('disconnects every device of a user signed out everywhere', () => {
      const disconnectSockets = jest.fn();
      server.in.mockReturnValueOnce({ socketsLeave: jest.fn(), disconnectSockets });

      makeGateway().handleUserSessionsRevoked({ userId: 'user-1', actorId: 'admin-1' });

      expect(server.in).toHaveBeenCalledWith('user:user-1');
      expect(disconnectSockets).toHaveBeenCalledWith(true);
    });

    it('counts the devices an alert would reach', () => {
      const gateway = makeGateway();
      gateway.server = {
        sockets: {
          sockets: new Map([
            ['a', {}],
            ['b', {}],
            ['c', {}],
          ]),
          adapter: { rooms: new Map([[`stream:${LIVE}`, new Set(['a', 'b'])]]) },
        },
      } as never;

      expect(gateway.connectedCount()).toBe(3);
      expect(gateway.connectedCount(LIVE)).toBe(2);
      expect(gateway.connectedCount(OTHER_LIVE)).toBe(0);
    });
  });
});
