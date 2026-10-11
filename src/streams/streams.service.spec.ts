import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ModeratorCapability,
  Prisma,
  RoomBanScope,
  StreamEndReason,
  StreamLayout,
  StreamStatus,
  StreamVisibility,
  UserStatus,
  VideoProviderKind,
} from '@prisma/client';
import { PermissionsService } from '../common/permissions/permissions.service';
import { LivePresenceService } from '../common/presence/live-presence.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { VideoProvider } from '../common/video-provider/video-provider.interface';
import { VideoProviderRegistry } from '../common/video-provider/video-provider.registry';
import { GuestsService } from '../guests/guests.service';
import { ModeratorsService } from '../moderators/moderators.service';
import { RecordingPermissionsService } from '../recording-permissions/recording-permissions.service';
import { RoomBansService } from '../room-bans/room-bans.service';
import { RoomChatMutesService } from '../room-chat-mutes/room-chat-mutes.service';
import { SocialService } from '../social/social.service';
import { WatchTicketService } from '../auth/watch-ticket.service';
import { StreamsService } from './streams.service';

describe('StreamsService', () => {
  const prisma = {
    scheduledLive: { findFirst: jest.fn(), updateMany: jest.fn() },
    stream: {
      groupBy: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    follow: {
      count: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    chatMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const videoProvider: jest.Mocked<VideoProvider> = {
    kind: VideoProviderKind.LIVEKIT,
    getClientConfig: jest.fn(() => ({ provider: VideoProviderKind.LIVEKIT })),
    createChannelName: jest.fn((id: string) => `stream_${id}`),
    openChannel: jest.fn().mockResolvedValue(undefined),
    mintToken: jest.fn().mockResolvedValue({
      provider: VideoProviderKind.LIVEKIT,
      url: 'wss://livekit.example.com',
      token: 'token',
      expiresAt: new Date(),
    }),
    revokeToken: jest.fn().mockResolvedValue(undefined),
    closeChannel: jest.fn().mockResolvedValue(undefined),
  };
  const videoProviders = {
    active: jest.fn(() => videoProvider),
    get: jest.fn(() => videoProvider),
  };
  const events = { emit: jest.fn() };
  const presence = {
    touchHost: jest.fn().mockResolvedValue(undefined),
    viewerCount: jest.fn().mockResolvedValue(0),
    viewerCounts: jest.fn().mockResolvedValue(new Map()),
    likeCounts: jest.fn().mockResolvedValue(new Map()),
    viewerIds: jest.fn().mockResolvedValue([]),
    pausedLives: jest.fn().mockResolvedValue(new Set()),
    isPaused: jest.fn().mockResolvedValue(false),
    likeCount: jest.fn().mockResolvedValue(0),
    peakViewerCount: jest.fn().mockResolvedValue(0),
    connectedHosts: jest.fn().mockResolvedValue(new Set()),
    presentHosts: jest.fn().mockResolvedValue(new Set()),
    setHostMedia: jest.fn().mockResolvedValue(undefined),
    noteGuestGone: jest.fn().mockResolvedValue(undefined),
    clearGuestGone: jest.fn().mockResolvedValue(undefined),
    takeGuestsGoneBefore: jest.fn().mockResolvedValue([]),
    clear: jest.fn().mockResolvedValue(undefined),
  };
  const social = {
    isFollowing: jest.fn().mockResolvedValue(false),
    isBlockedEitherWay: jest.fn().mockResolvedValue(false),
    blockedEitherWayUserIds: jest.fn().mockResolvedValue([]),
  };
  const moderators = {
    findActiveGrant: jest.fn().mockResolvedValue(null),
    isActiveModerator: jest.fn().mockResolvedValue(false),
    list: jest.fn(),
    grant: jest.fn(),
    updateCapabilities: jest.fn(),
    revoke: jest.fn(),
  };
  const roomBans = {
    isBanned: jest.fn().mockResolvedValue(false),
    ban: jest.fn(),
    unban: jest.fn(),
  };
  const guests = {
    activeGuests: jest.fn().mockResolvedValue([]),
    isActiveGuest: jest.fn().mockResolvedValue(false),
    findOwnPending: jest.fn().mockResolvedValue(null),
    request: jest.fn(),
    invite: jest.fn(),
    cancel: jest.fn(),
    listPending: jest.fn(),
    findPendingOrThrow: jest.fn(),
    countActiveGuests: jest.fn().mockResolvedValue(0),
    accept: jest.fn(),
    reject: jest.fn(),
    remove: jest.fn(),
    removeAllForEndedStream: jest.fn().mockResolvedValue(undefined),
    setMicForceMuted: jest.fn(),
    setPlacement: jest.fn(),
    setSpotlight: jest.fn(),
  };
  const roomChatMutes = {
    mute: jest.fn(),
    unmute: jest.fn(),
    listActive: jest.fn(),
  };
  const watchTickets = {
    issue: jest
      .fn()
      .mockResolvedValue({ viewerId: 'web-anon-1', streamId: 's1', ticket: 'ticket-1' }),
  };
  const recordingPermissions = {
    allow: jest.fn(),
    disallow: jest.fn(),
    isAllowed: jest.fn().mockResolvedValue(false),
    list: jest.fn(),
  };

  function makeService() {
    return new StreamsService(
      prisma as unknown as PrismaService,
      new PermissionsService(),
      videoProviders as unknown as VideoProviderRegistry,
      events as unknown as EventEmitter2,
      presence as unknown as LivePresenceService,
      social as unknown as SocialService,
      moderators as unknown as ModeratorsService,
      roomBans as unknown as RoomBansService,
      guests as unknown as GuestsService,
      roomChatMutes as unknown as RoomChatMutesService,
      watchTickets as unknown as WatchTicketService,
      recordingPermissions as unknown as RecordingPermissionsService,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.stream.updateMany.mockResolvedValue({ count: 1 });
  });

  it("returns the active provider's config for the pre-publish camera preview", () => {
    const service = makeService();

    expect(service.getVideoConfig()).toEqual({ provider: 'LIVEKIT' });
  });

  it('creates a live stream on the active provider and mints a publisher token', async () => {
    prisma.stream.create.mockImplementation(({ data }: Prisma.StreamCreateArgs) =>
      Promise.resolve({ ...data }),
    );
    const service = makeService();

    const result = await service.goLive('host-1', { title: 'Casino night' });

    const channelName = videoProvider.createChannelName.mock.results[0].value;
    expect(result.stream).toMatchObject({
      hostId: 'host-1',
      videoProvider: 'LIVEKIT',
      channelName,
    });
    expect(videoProvider.mintToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'host-1', role: 'publisher', channelName }),
    );
    expect(result.rtcToken).toMatchObject({
      provider: 'LIVEKIT',
      url: 'wss://livekit.example.com',
    });
  });

  it('opens the media channel before the stream row exists', async () => {
    prisma.stream.create.mockImplementation(({ data }: Prisma.StreamCreateArgs) =>
      Promise.resolve({ ...data }),
    );
    const service = makeService();

    await service.goLive('host-1', { title: 'Casino night' });

    expect(videoProvider.openChannel.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.stream.create.mock.invocationCallOrder[0],
    );
  });

  it('emits stream.started for the notifications fan-out (plan §6.11), outside the response path', async () => {
    prisma.stream.create.mockImplementation(({ data }: Prisma.StreamCreateArgs) =>
      Promise.resolve({ ...data }),
    );
    const service = makeService();

    const result = await service.goLive('host-1', { title: 'Casino night' });

    expect(events.emit).toHaveBeenCalledWith('stream.started', {
      streamId: result.stream.id,
      hostId: 'host-1',
      title: 'Casino night',
    });
  });

  it('does not create a stream when the media server is down', async () => {
    videoProvider.openChannel.mockRejectedValueOnce(new ServiceUnavailableException());
    const service = makeService();

    await expect(service.goLive('host-1', { title: 'Casino night' })).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(prisma.stream.create).not.toHaveBeenCalled();
  });

  it("auto-ends a host's existing live stream before starting a new one", async () => {
    prisma.stream.findFirst.mockResolvedValue({
      id: 'old-stream',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
    });
    prisma.stream.findUnique.mockResolvedValue({
      id: 'old-stream',
      status: StreamStatus.ENDED,
      videoProvider: VideoProviderKind.AGORA,
      channelName: 'stream_old-stream',
    });
    prisma.stream.create.mockImplementation(({ data }: Prisma.StreamCreateArgs) =>
      Promise.resolve({ ...data }),
    );
    const service = makeService();

    const result = await service.goLive('host-1', { title: 'Take two' });

    expect(prisma.stream.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'old-stream', status: StreamStatus.LIVE },
        data: expect.objectContaining({ endedReason: StreamEndReason.REPLACED }),
      }),
    );
    expect(events.emit).toHaveBeenCalledWith('stream.ended', {
      streamId: 'old-stream',
      reason: 'REPLACED',
    });
    expect(videoProviders.get).toHaveBeenCalledWith('AGORA');
    expect(videoProvider.closeChannel).toHaveBeenCalledWith('stream_old-stream');
    expect(result.stream.hostId).toBe('host-1');
  });

  it("counts going live as the host's first heartbeat and returns the server time", async () => {
    prisma.stream.create.mockImplementation(({ data }: Prisma.StreamCreateArgs) =>
      Promise.resolve({ ...data }),
    );
    const service = makeService();

    const result = await service.goLive('host-1', { title: 'Casino night' });

    expect(presence.touchHost).toHaveBeenCalledWith(result.stream.id);
    expect(result.serverTime).toBeInstanceOf(Date);
  });

  it('still goes live when the heartbeat store is briefly unreachable', async () => {
    prisma.stream.create.mockImplementation(({ data }: Prisma.StreamCreateArgs) =>
      Promise.resolve({ ...data }),
    );
    presence.touchHost.mockRejectedValueOnce(new Error('Redis down'));
    const service = makeService();

    await expect(service.goLive('host-1', { title: 'Casino night' })).resolves.toHaveProperty(
      'rtcToken',
    );
  });

  it('lets a viewer join with an audience token from the vendor the live started on', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.AGORA,
      channelName: 'stream_s1',
    });
    const service = makeService();

    const result = await service.join('s1', 'viewer-1');

    expect(videoProviders.get).toHaveBeenCalledWith('AGORA');
    expect(videoProvider.mintToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'viewer-1', role: 'audience', channelName: 'stream_s1' }),
    );
    expect(result.stream.id).toBe('s1');
    expect(result.isFollowingHost).toBe(false);
    expect(result.selfCapabilities).toEqual([]);
    expect(result.pinnedMessage).toBeNull();
    expect(result.canRecord).toBe(false);
  });

  it('tells a joining viewer the host lets them record', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.AGORA,
      channelName: 'stream_s1',
    });
    recordingPermissions.isAllowed.mockResolvedValueOnce(true);

    const result = await makeService().join('s1', 'fan-1');

    expect(recordingPermissions.isAllowed).toHaveBeenCalledWith('s1', 'fan-1');
    expect(result.canRecord).toBe(true);
  });

  it('shows a pinned photo as one in the banner', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.AGORA,
      channelName: 'stream_s1',
      pinnedMessageId: 'm2',
    });
    prisma.chatMessage.findUnique.mockResolvedValueOnce({
      id: 'm2',
      text: '',
      imageUrl: 'https://media.example/chat-images/s1/p.jpg',
      user: { displayName: 'Host' },
    });

    const result = await makeService().join('s1', 'viewer-1');

    expect(result.pinnedMessage).toEqual({ id: 'm2', text: '📷 Photo', senderName: 'Host' });
  });

  it('tells a joining moderator their own capabilities, and the current pin', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.AGORA,
      channelName: 'stream_s1',
      pinnedMessageId: 'm1',
    });
    moderators.findActiveGrant.mockResolvedValueOnce({
      capabilities: [ModeratorCapability.PIN_MESSAGES],
    });
    prisma.chatMessage.findUnique.mockResolvedValueOnce({
      id: 'm1',
      text: 'Welcome!',
      user: { displayName: 'Host' },
    });
    const service = makeService();

    const result = await service.join('s1', 'mod-1');

    expect(moderators.findActiveGrant).toHaveBeenCalledWith('s1', 'mod-1');
    expect(result.selfCapabilities).toEqual([ModeratorCapability.PIN_MESSAGES]);
    expect(result.pinnedMessage).toEqual({ id: 'm1', text: 'Welcome!', senderName: 'Host' });
  });

  it('reports whether the viewer already follows the host when joining', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.AGORA,
      channelName: 'stream_s1',
    });
    social.isFollowing.mockResolvedValueOnce(true);
    const service = makeService();

    const result = await service.join('s1', 'viewer-1');

    expect(social.isFollowing).toHaveBeenCalledWith('viewer-1', 'host-1');
    expect(result.isFollowingHost).toBe(true);
  });

  it('rejects joining a stream that has already ended', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.ENDED,
      channelName: 'stream_s1',
    });
    const service = makeService();

    await expect(service.join('s1', 'viewer-1')).rejects.toThrow(NotFoundException);
  });

  it('rejects joining a stream the viewer is room-banned from', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.AGORA,
      channelName: 'stream_s1',
    });
    roomBans.isBanned.mockResolvedValueOnce(true);
    const service = makeService();

    await expect(service.join('s1', 'viewer-1')).rejects.toThrow(ForbiddenException);
    expect(roomBans.isBanned).toHaveBeenCalledWith('host-1', 'viewer-1', 's1');
    expect(videoProvider.mintToken).not.toHaveBeenCalled();
  });

  it('treats a live as gone for someone blocked either way with its host', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.AGORA,
      channelName: 'stream_s1',
    });
    social.isBlockedEitherWay.mockResolvedValueOnce(true);
    const service = makeService();

    await expect(service.join('s1', 'viewer-1')).rejects.toThrow(NotFoundException);
    expect(social.isBlockedEitherWay).toHaveBeenCalledWith('host-1', 'viewer-1');
    expect(videoProvider.mintToken).not.toHaveBeenCalled();
  });

  describe('publisherToken (getting back on air)', () => {
    const live = {
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.LIVEKIT,
      channelName: 'stream_s1',
    };

    it("mints the host a fresh publisher token on the live's own vendor", async () => {
      prisma.stream.findUnique.mockResolvedValue(live);
      const service = makeService();

      const result = await service.publisherToken('s1', 'host-1');

      expect(videoProviders.get).toHaveBeenCalledWith(VideoProviderKind.LIVEKIT);
      // Reopened if the media server closed it meanwhile (a no-op otherwise).
      expect(videoProvider.openChannel).toHaveBeenCalledWith('stream_s1');
      expect(videoProvider.mintToken).toHaveBeenCalledWith({
        channelName: 'stream_s1',
        userId: 'host-1',
        role: 'publisher',
      });
      expect(result.rtcToken).toMatchObject({
        provider: VideoProviderKind.LIVEKIT,
        token: 'token',
      });
    });

    it('mints one for a guest still on stage', async () => {
      prisma.stream.findUnique.mockResolvedValue(live);
      guests.isActiveGuest.mockResolvedValueOnce(true);
      const service = makeService();

      await service.publisherToken('s1', 'guest-1');

      expect(guests.isActiveGuest).toHaveBeenCalledWith('s1', 'guest-1');
      expect(videoProvider.mintToken).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'guest-1', role: 'publisher' }),
      );
    });

    it('refuses a viewer who is not on stage', async () => {
      prisma.stream.findUnique.mockResolvedValue(live);
      const service = makeService();

      await expect(service.publisherToken('s1', 'viewer-1')).rejects.toThrow(ForbiddenException);
      expect(videoProvider.mintToken).not.toHaveBeenCalled();
    });

    it('refuses once the live is over', async () => {
      prisma.stream.findUnique.mockResolvedValue({ ...live, status: StreamStatus.ENDED });
      const service = makeService();

      await expect(service.publisherToken('s1', 'host-1')).rejects.toThrow(NotFoundException);
      expect(videoProvider.mintToken).not.toHaveBeenCalled();
    });
  });

  describe('watch (the share page player)', () => {
    const live = {
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.AGORA,
      channelName: 'stream_s1',
    };

    it('lets anyone watch - the video goes to an anonymous identity, with a ticket for the live updates', async () => {
      prisma.stream.findUnique.mockResolvedValue(live);
      const service = makeService();

      const result = await service.watch('s1');

      expect(watchTickets.issue).toHaveBeenCalledWith('s1');
      expect(videoProviders.get).toHaveBeenCalledWith('AGORA');
      expect(videoProvider.mintToken).toHaveBeenCalledWith({
        channelName: 'stream_s1',
        userId: 'web-anon-1',
        role: 'audience',
      });
      expect(result).toMatchObject({
        watchTicket: 'ticket-1',
        isFollowingHost: false,
        activeGuests: [],
      });
      expect(roomBans.isBanned).not.toHaveBeenCalled();
      expect(social.isFollowing).not.toHaveBeenCalled();
    });

    it("never gives a signed-in viewer's own identity to the video, but says whether they follow the host", async () => {
      prisma.stream.findUnique.mockResolvedValue(live);
      social.isFollowing.mockResolvedValueOnce(true);
      const service = makeService();

      const result = await service.watch('s1', 'viewer-1');

      expect(videoProvider.mintToken).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'web-anon-1' }),
      );
      expect(social.isFollowing).toHaveBeenCalledWith('viewer-1', 'host-1');
      expect(result.isFollowingHost).toBe(true);
    });

    it('keeps a banned viewer out, even on the web', async () => {
      prisma.stream.findUnique.mockResolvedValue(live);
      roomBans.isBanned.mockResolvedValueOnce(true);
      const service = makeService();

      await expect(service.watch('s1', 'viewer-1')).rejects.toThrow(ForbiddenException);
      expect(videoProvider.mintToken).not.toHaveBeenCalled();
    });

    it('keeps someone blocked either way with the host out, even on the web', async () => {
      prisma.stream.findUnique.mockResolvedValue(live);
      social.isBlockedEitherWay.mockResolvedValueOnce(true);
      const service = makeService();

      await expect(service.watch('s1', 'viewer-1')).rejects.toThrow(NotFoundException);
      expect(social.isBlockedEitherWay).toHaveBeenCalledWith('host-1', 'viewer-1');
      expect(videoProvider.mintToken).not.toHaveBeenCalled();
    });

    it('has nothing to show once the live is over', async () => {
      prisma.stream.findUnique.mockResolvedValue({ ...live, status: StreamStatus.ENDED });
      const service = makeService();

      await expect(service.watch('s1')).rejects.toThrow(NotFoundException);
      expect(watchTickets.issue).not.toHaveBeenCalled();
    });
  });

  it('lets the host end their own stream, emits stream.ended and closes the channel', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.LIVEKIT,
      channelName: 'stream_s1',
    });
    const service = makeService();

    await service.end('s1', 'host-1');

    expect(prisma.stream.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1', status: StreamStatus.LIVE },
        data: expect.objectContaining({
          status: StreamStatus.ENDED,
          endedReason: StreamEndReason.HOST_ENDED,
        }),
      }),
    );
    expect(events.emit).toHaveBeenCalledWith('stream.ended', {
      streamId: 's1',
      reason: 'HOST_ENDED',
    });
    expect(presence.clear).toHaveBeenCalledWith('s1');
    expect(videoProviders.get).toHaveBeenCalledWith('LIVEKIT');
    expect(videoProvider.closeChannel).toHaveBeenCalledWith('stream_s1');
  });

  it("saves the live's peak viewer count and like total when it ends", async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
    });
    presence.peakViewerCount.mockResolvedValueOnce(42);
    presence.likeCount.mockResolvedValueOnce(1300);
    const service = makeService();

    await service.end('s1', 'host-1');

    expect(prisma.stream.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ peakViewerCount: 42, likeCount: 1300 }),
      }),
    );
  });

  it("announces a live's end only once when the host and the sweeper race", async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.ENDED,
    });
    prisma.stream.updateMany.mockResolvedValue({ count: 0 });
    const service = makeService();

    await expect(service.end('s1', 'host-1')).resolves.toMatchObject({
      status: StreamStatus.ENDED,
    });
    expect(events.emit).not.toHaveBeenCalled();
    expect(presence.clear).not.toHaveBeenCalled();
    expect(videoProvider.closeChannel).not.toHaveBeenCalled();
  });

  it('still ends the stream when the media server cannot close the channel', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.ENDED,
      videoProvider: VideoProviderKind.LIVEKIT,
      channelName: 'stream_s1',
    });
    videoProvider.closeChannel.mockRejectedValueOnce(new ServiceUnavailableException());
    const service = makeService();

    await expect(service.end('s1', 'host-1')).resolves.toMatchObject({
      status: StreamStatus.ENDED,
    });
  });

  it('refuses to let a non-host end the stream', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
    });
    const service = makeService();

    await expect(service.end('s1', 'someone-else')).rejects.toThrow(ForbiddenException);
    expect(prisma.stream.updateMany).not.toHaveBeenCalled();
  });

  it('starts the live in the layout the host picked', async () => {
    prisma.stream.create.mockImplementation(({ data }: Prisma.StreamCreateArgs) =>
      Promise.resolve({ ...data }),
    );
    const service = makeService();

    await service.goLive('host-1', { title: 'Split test', layout: StreamLayout.SPLIT });

    expect(prisma.stream.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ layout: StreamLayout.SPLIT }) }),
    );
  });

  it('lets the host change the layout mid-live and broadcasts it', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      layout: StreamLayout.FULL,
    });
    prisma.stream.update.mockResolvedValue({ id: 's1', layout: StreamLayout.FLOATING });
    const service = makeService();

    const result = await service.updateLayout('s1', 'host-1', StreamLayout.FLOATING);

    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { layout: StreamLayout.FLOATING },
    });
    expect(events.emit).toHaveBeenCalledWith('stream.layout_changed', {
      streamId: 's1',
      layout: StreamLayout.FLOATING,
    });
    expect(result.layout).toBe(StreamLayout.FLOATING);
  });

  it('does not write or re-broadcast when the layout is unchanged', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      layout: StreamLayout.FIT,
    });
    const service = makeService();

    await service.updateLayout('s1', 'host-1', StreamLayout.FIT);

    expect(prisma.stream.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses a layout change from anyone but the host', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      layout: StreamLayout.FULL,
    });
    const service = makeService();

    await expect(service.updateLayout('s1', 'viewer-1', StreamLayout.MINIMAL)).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.stream.update).not.toHaveBeenCalled();
  });

  it('rejects a layout change on a live that already ended', async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.ENDED,
      layout: StreamLayout.FULL,
    });
    const service = makeService();

    await expect(service.updateLayout('s1', 'host-1', StreamLayout.FIT)).rejects.toThrow(
      NotFoundException,
    );
  });

  describe('discovery list', () => {
    const live = (id: string, minutesAgo: number) => ({
      id,
      title: id,
      category: null,
      visibility: StreamVisibility.PUBLIC,
      host: { id: `host-${id}` },
      startedAt: new Date(Date.now() - minutesAgo * 60_000),
    });

    it('ranks lives by viewer count, newest first among equals', async () => {
      // Prisma returns them newest first.
      prisma.stream.findMany.mockResolvedValue([live('new', 1), live('busy', 5), live('old', 30)]);
      presence.viewerCounts.mockResolvedValue(
        new Map([
          ['new', 2],
          ['busy', 9],
          ['old', 2],
        ]),
      );
      const service = makeService();

      const result = await service.listLive({ page: 1, limit: 20 });

      expect(result.items.map((item) => [item.id, item.viewerCount])).toEqual([
        ['busy', 9],
        ['new', 2],
        ['old', 2],
      ]);
      expect(result.total).toBe(3);
      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: StreamStatus.LIVE },
          orderBy: { startedAt: 'desc' },
        }),
      );
    });

    it('filters by category, ignoring case', async () => {
      prisma.stream.findMany.mockResolvedValue([]);
      const service = makeService();

      await service.listLive({ category: 'poker', page: 1, limit: 20 });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: StreamStatus.LIVE, category: { equals: 'poker', mode: 'insensitive' } },
        }),
      );
    });

    it('excludes hosts blocked either way for a signed-in requester', async () => {
      prisma.stream.findMany.mockResolvedValue([]);
      social.blockedEitherWayUserIds.mockResolvedValueOnce(['blocked-1']);
      const service = makeService();

      await service.listLive({ page: 1, limit: 20 }, 'viewer-1');

      expect(social.blockedEitherWayUserIds).toHaveBeenCalledWith('viewer-1');
      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: StreamStatus.LIVE, hostId: { notIn: ['blocked-1'] } },
        }),
      );
    });

    it('combines the following filter and the block exclusion on the same hostId field', async () => {
      prisma.stream.findMany.mockResolvedValue([]);
      prisma.follow.findMany.mockResolvedValue([{ followeeId: 'followed-1' }]);
      social.blockedEitherWayUserIds.mockResolvedValueOnce(['blocked-1']);
      const service = makeService();

      await service.listLive({ feed: 'following', page: 1, limit: 20 }, 'viewer-1');

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: StreamStatus.LIVE,
            hostId: { in: ['followed-1'], notIn: ['blocked-1'] },
          },
        }),
      );
    });

    it('pages through the ranked list', async () => {
      prisma.stream.findMany.mockResolvedValue([live('a', 1), live('b', 2), live('c', 3)]);
      presence.viewerCounts.mockResolvedValue(new Map([['c', 5]]));
      const service = makeService();

      const result = await service.listLive({ page: 2, limit: 2 });

      expect(result.items.map((item) => item.id)).toEqual(['b']);
      expect(result).toMatchObject({ total: 3, page: 2, limit: 2 });
    });

    it('falls back to newest first when viewer counts are unavailable', async () => {
      prisma.stream.findMany.mockResolvedValue([live('a', 1), live('b', 2)]);
      presence.viewerCounts.mockRejectedValueOnce(new Error('Redis down'));
      presence.pausedLives.mockRejectedValueOnce(new Error('Redis down'));
      const service = makeService();

      const result = await service.listLive({ page: 1, limit: 20 });

      expect(result.items.map((item) => [item.id, item.viewerCount, item.paused])).toEqual([
        ['a', 0, false],
        ['b', 0, false],
      ]);
    });

    it('marks paused lives, which sink below a running one of similar pull', async () => {
      prisma.stream.findMany.mockResolvedValue([live('on', 1), live('paused', 2)]);
      presence.viewerCounts.mockResolvedValue(
        new Map([
          ['on', 1],
          ['paused', 7],
        ]),
      );
      presence.pausedLives.mockResolvedValueOnce(new Set(['paused']));
      const service = makeService();

      const result = await service.listLive({ page: 1, limit: 20 });

      expect(result.items.map((item) => [item.id, item.paused])).toEqual([
        ['on', false],
        ['paused', true],
      ]);
    });
  });

  describe("followers' and friends' lives", () => {
    const friendsLive = {
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.FRIENDS,
      videoProvider: VideoProviderKind.LIVEKIT,
      channelName: 'stream_s1',
    };
    // [viewer follows host, host follows viewer]
    const ties = (follows: boolean, followedBack: boolean) =>
      social.isFollowing.mockImplementation(async (follower: string) =>
        follower === 'host-1' ? followedBack : follows,
      );

    afterEach(() => social.isFollowing.mockResolvedValue(false));

    it("turns away someone who isn't a friend, saying why", async () => {
      prisma.stream.findUnique.mockResolvedValue(friendsLive);
      ties(true, false);
      const service = makeService();

      await expect(service.join('s1', 'viewer-1')).rejects.toMatchObject({
        response: { code: 'LIVE_RESTRICTED', message: "This live is for the host's friends." },
      });
      expect(videoProvider.mintToken).not.toHaveBeenCalled();
    });

    it('lets a friend in', async () => {
      prisma.stream.findUnique.mockResolvedValue(friendsLive);
      ties(true, true);
      const service = makeService();

      await expect(service.join('s1', 'viewer-1')).resolves.toBeDefined();
    });

    it("a followers' live is for any follower", async () => {
      const service = makeService();
      const followersLive = { ...friendsLive, visibility: StreamVisibility.FOLLOWERS };
      ties(true, false);
      await expect(service.canWatch(followersLive, 'viewer-1')).resolves.toBe(true);
      ties(false, true);
      await expect(service.canWatch(followersLive, 'viewer-1')).resolves.toBe(false);
    });

    it('never locks out the host, a guest on stage or a moderator of the live', async () => {
      const service = makeService();
      ties(false, false);
      await expect(service.canWatch(friendsLive, 'host-1')).resolves.toBe(true);
      guests.isActiveGuest.mockResolvedValueOnce(true);
      await expect(service.canWatch(friendsLive, 'guest-1')).resolves.toBe(true);
      moderators.findActiveGrant.mockResolvedValueOnce({ capabilities: [] });
      await expect(service.canWatch(friendsLive, 'mod-1')).resolves.toBe(true);
      await expect(service.canWatch(friendsLive, 'stranger-1')).resolves.toBe(false);
    });

    it("the share page's player is for everyone only on a public live", async () => {
      prisma.stream.findUnique.mockResolvedValue(friendsLive);
      const service = makeService();

      await expect(service.watch('s1')).rejects.toThrow(ForbiddenException);
      expect(watchTickets.issue).not.toHaveBeenCalled();
    });

    it("a running restricted live is unknown to anyone who can't watch it; once over, it's just a past live", async () => {
      prisma.stream.findUnique.mockResolvedValue({ ...friendsLive, host: { id: 'host-1' } });
      ties(false, false);
      const service = makeService();
      await expect(service.getPublic('s1', 'viewer-1')).rejects.toThrow(NotFoundException);
      await expect(service.getPublic('s1')).rejects.toThrow(NotFoundException);

      prisma.stream.findUnique.mockResolvedValue({
        ...friendsLive,
        status: StreamStatus.ENDED,
        likeCount: 3,
        host: { id: 'host-1' },
      });
      await expect(service.getPublic('s1', 'viewer-1')).resolves.toMatchObject({ id: 's1' });
    });

    it('discovery shows each viewer only the lives they may watch', async () => {
      const row = (id: string, hostId: string, visibility: StreamVisibility) => ({
        id,
        title: id,
        category: null,
        visibility,
        host: { id: hostId },
        startedAt: new Date(),
      });
      prisma.stream.findMany.mockResolvedValue([
        row('public', 'stranger', StreamVisibility.PUBLIC),
        row('followers', 'followed', StreamVisibility.FOLLOWERS),
        row('friends-of-followed', 'followed', StreamVisibility.FRIENDS),
        row('friends', 'friend', StreamVisibility.FRIENDS),
        row('strangers-friends', 'stranger', StreamVisibility.FRIENDS),
      ]);
      // viewer follows 'followed' and 'friend'; only 'friend' follows back.
      prisma.follow.findMany
        .mockResolvedValueOnce([{ followeeId: 'followed' }, { followeeId: 'friend' }])
        .mockResolvedValueOnce([{ followerId: 'friend' }]);
      const service = makeService();

      const signedIn = await service.listLive({ page: 1, limit: 20 }, 'viewer-1');
      expect(signedIn.items.map((item) => item.id).sort()).toEqual([
        'followers',
        'friends',
        'public',
      ]);

      const anonymous = await service.listLive({ page: 1, limit: 20 });
      expect(anonymous.items.map((item) => item.id)).toEqual(['public']);
    });

    it('searches titles and host names, ignoring case', async () => {
      prisma.stream.findMany.mockResolvedValue([]);
      const service = makeService();

      await service.listLive({ q: 'poker', page: 1, limit: 20 });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: StreamStatus.LIVE,
            OR: [
              { title: { contains: 'poker', mode: 'insensitive' } },
              { host: { displayName: { contains: 'poker', mode: 'insensitive' } } },
              { host: { username: { contains: 'poker', mode: 'insensitive' } } },
            ],
          },
        }),
      );
    });

    it('goes live with the chosen audience, and says so to the notifications', async () => {
      prisma.stream.create.mockImplementation(({ data }: Prisma.StreamCreateArgs) =>
        Promise.resolve({ ...data }),
      );
      const service = makeService();

      await service.goLive('host-1', {
        title: 'Close friends',
        visibility: StreamVisibility.FRIENDS,
      });

      expect(prisma.stream.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ visibility: StreamVisibility.FRIENDS }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'stream.started',
        expect.objectContaining({ visibility: StreamVisibility.FRIENDS }),
      );
    });
  });

  describe('going live from a scheduled live', () => {
    beforeEach(() => {
      prisma.stream.create.mockImplementation(({ data }: Prisma.StreamCreateArgs) =>
        Promise.resolve({ ...data }),
      );
    });

    it('takes its audience, fulfils it, and tells the notifications whose reminders to honour', async () => {
      prisma.scheduledLive.findFirst.mockResolvedValue({
        id: 'e1',
        visibility: StreamVisibility.FOLLOWERS,
      });
      prisma.scheduledLive.updateMany.mockResolvedValue({ count: 1 });
      const service = makeService();

      const result = await service.goLive('host-1', { title: 'Poker', scheduledLiveId: 'e1' });

      expect(prisma.scheduledLive.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'e1',
            hostId: 'host-1',
            cancelledAt: null,
            streamId: null,
          }),
        }),
      );
      expect(prisma.stream.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ visibility: StreamVisibility.FOLLOWERS }),
        }),
      );
      expect(prisma.scheduledLive.updateMany).toHaveBeenCalledWith({
        where: { id: 'e1', hostId: 'host-1', streamId: null, cancelledAt: null },
        data: { streamId: result.stream.id },
      });
      expect(events.emit).toHaveBeenCalledWith(
        'stream.started',
        expect.objectContaining({ scheduledLiveId: 'e1' }),
      );
    });

    it("refuses one that isn't the host's, or isn't coming up - before going live", async () => {
      prisma.scheduledLive.findFirst.mockResolvedValue(null);
      const service = makeService();

      await expect(
        service.goLive('host-1', { title: 'Poker', scheduledLiveId: 'e1' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.stream.create).not.toHaveBeenCalled();
      expect(videoProvider.openChannel).not.toHaveBeenCalled();
    });
  });

  describe('stream detail', () => {
    it('includes the live viewer count, likes and pause state while live', async () => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
        likeCount: 0,
      });
      presence.viewerCount.mockResolvedValueOnce(12);
      presence.isPaused.mockResolvedValueOnce(true);
      presence.likeCount.mockResolvedValueOnce(88);
      const service = makeService();

      await expect(service.getPublic('s1')).resolves.toMatchObject({
        id: 's1',
        viewerCount: 12,
        paused: true,
        likeCount: 88,
      });
    });

    it('reports an ended live without asking for viewers', async () => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        status: StreamStatus.ENDED,
        endedReason: StreamEndReason.HOST_DISCONNECTED,
        likeCount: 640,
      });
      const service = makeService();

      await expect(service.getPublic('s1')).resolves.toMatchObject({
        viewerCount: 0,
        paused: false,
        likeCount: 640,
        endedReason: 'HOST_DISCONNECTED',
      });
      expect(presence.viewerCount).not.toHaveBeenCalled();
      expect(presence.isPaused).not.toHaveBeenCalled();
      expect(presence.likeCount).not.toHaveBeenCalled();
    });

    it('404s for an unknown stream', async () => {
      prisma.stream.findUnique.mockResolvedValue(null);
      const service = makeService();

      await expect(service.getPublic('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('abandoned lives', () => {
    const now = new Date('2026-09-25T12:00:00Z');

    it('ends lives whose host stopped sending heartbeats', async () => {
      prisma.stream.findMany.mockResolvedValue([{ id: 'alive' }, { id: 'gone' }]);
      presence.presentHosts.mockResolvedValue(new Set(['alive']));
      prisma.stream.findUnique.mockResolvedValue({ id: 'gone', status: StreamStatus.ENDED });
      const service = makeService();

      await expect(service.endAbandonedLives(now)).resolves.toBe(1);

      expect(prisma.stream.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.stream.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'gone', status: StreamStatus.LIVE },
          data: expect.objectContaining({ endedReason: StreamEndReason.HOST_DISCONNECTED }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith('stream.ended', {
        streamId: 'gone',
        reason: 'HOST_DISCONNECTED',
      });
    });

    it('leaves lives younger than the grace window alone', async () => {
      prisma.stream.findMany.mockResolvedValue([]);
      const service = makeService();

      await expect(service.endAbandonedLives(now)).resolves.toBe(0);

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: StreamStatus.LIVE, startedAt: { lt: new Date('2026-09-25T11:58:30Z') } },
        }),
      );
      expect(presence.presentHosts).not.toHaveBeenCalled();
    });

    it("asks with the sweep's own clock whether each host is still there", async () => {
      prisma.stream.findMany.mockResolvedValue([{ id: 'live-1' }]);
      presence.presentHosts.mockResolvedValue(new Set(['live-1']));
      const service = makeService();

      await expect(service.endAbandonedLives(now)).resolves.toBe(0);
      expect(presence.presentHosts).toHaveBeenCalledWith(['live-1'], now.getTime());
    });
  });

  describe('media room events (LiveKit webhooks)', () => {
    const live = {
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.LIVEKIT,
      channelName: 'stream_s1',
    };

    beforeEach(() => {
      prisma.stream.findUnique.mockResolvedValue(live);
    });

    it("notes the host's video in the room, and its leaving", async () => {
      presence.connectedHosts.mockResolvedValue(new Set(['s1']));
      const service = makeService();

      await service.onMediaRoomEvent({
        type: 'publisher_joined',
        channelName: 'stream_s1',
        userId: 'host-1',
      });
      await service.onMediaRoomEvent({
        type: 'publisher_left',
        channelName: 'stream_s1',
        userId: 'host-1',
      });

      expect(prisma.stream.findUnique).toHaveBeenCalledWith({
        where: { channelName: 'stream_s1' },
      });
      expect(presence.setHostMedia).toHaveBeenNthCalledWith(1, 's1', true);
      expect(presence.setHostMedia).toHaveBeenNthCalledWith(2, 's1', false);
      // The app's still there (its heartbeat is on): it reconnects the video.
      expect(prisma.stream.updateMany).not.toHaveBeenCalled();
    });

    it("ends the live at once when the host's video left and their app is silent too", async () => {
      presence.connectedHosts.mockResolvedValue(new Set());
      const service = makeService();

      await service.onMediaRoomEvent({
        type: 'publisher_left',
        channelName: 'stream_s1',
        userId: 'host-1',
      });

      expect(prisma.stream.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ endedReason: StreamEndReason.HOST_DISCONNECTED }),
        }),
      );
    });

    it("a guest's video leaving puts them on notice; coming back clears it", async () => {
      guests.isActiveGuest.mockResolvedValueOnce(true);
      const service = makeService();

      await service.onMediaRoomEvent({
        type: 'publisher_left',
        channelName: 'stream_s1',
        userId: 'guest-1',
      });
      await service.onMediaRoomEvent({
        type: 'publisher_joined',
        channelName: 'stream_s1',
        userId: 'guest-1',
      });

      expect(presence.noteGuestGone).toHaveBeenCalledWith('s1', 'guest-1');
      expect(presence.clearGuestGone).toHaveBeenCalledWith('s1', 'guest-1');
      expect(presence.setHostMedia).not.toHaveBeenCalled();
    });

    it('a closed room ends the live only when the host is gone too', async () => {
      const service = makeService();

      presence.connectedHosts.mockResolvedValueOnce(new Set(['s1']));
      await service.onMediaRoomEvent({ type: 'room_finished', channelName: 'stream_s1' });
      expect(prisma.stream.updateMany).not.toHaveBeenCalled();

      presence.connectedHosts.mockResolvedValueOnce(new Set());
      await service.onMediaRoomEvent({ type: 'room_finished', channelName: 'stream_s1' });
      expect(prisma.stream.updateMany).toHaveBeenCalledTimes(1);
    });

    it('ignores rooms of lives that are over', async () => {
      prisma.stream.findUnique.mockResolvedValue({ ...live, status: StreamStatus.ENDED });
      const service = makeService();

      await service.onMediaRoomEvent({
        type: 'publisher_left',
        channelName: 'stream_s1',
        userId: 'host-1',
      });

      expect(presence.setHostMedia).not.toHaveBeenCalled();
      expect(presence.connectedHosts).not.toHaveBeenCalled();
    });

    it('takes a guest whose video never came back off the stage', async () => {
      presence.takeGuestsGoneBefore.mockResolvedValue([{ streamId: 's1', userId: 'guest-1' }]);
      guests.isActiveGuest.mockResolvedValue(true);
      const service = makeService();
      const now = new Date('2026-10-10T12:00:00Z');

      await expect(service.vacateDroppedGuests(now)).resolves.toBe(1);

      expect(presence.takeGuestsGoneBefore).toHaveBeenCalledWith(now.getTime() - 75_000);
      expect(guests.remove).toHaveBeenCalledWith('s1', 'host-1', 'guest-1', false, 'guest-1');
      guests.isActiveGuest.mockResolvedValue(false);
    });

    it('leaves a dropped guest who already left the stage alone', async () => {
      presence.takeGuestsGoneBefore.mockResolvedValue([{ streamId: 's1', userId: 'guest-1' }]);
      const service = makeService();

      await expect(service.vacateDroppedGuests()).resolves.toBe(0);
      expect(guests.remove).not.toHaveBeenCalled();
    });
  });

  it('looks up a live for the realtime gateway, or nothing once it ended', async () => {
    prisma.stream.findFirst.mockResolvedValue(null);
    const service = makeService();

    await expect(service.findLive('s1')).resolves.toBeNull();
    expect(prisma.stream.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 's1', status: StreamStatus.LIVE } }),
    );
  });

  describe('admin lock (plan §6.8)', () => {
    const live = {
      id: 's1',
      hostId: 'host-1',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      channelName: 'stream_s1',
      videoProvider: VideoProviderKind.LIVEKIT,
    };

    it('ends a running live as LOCKED, records who and why, and says so before the end', async () => {
      prisma.stream.findUnique.mockResolvedValue(live);
      const service = makeService();

      await service.lock('s1', 'admin-1', 'Graphic violence');

      expect(prisma.stream.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', status: StreamStatus.LIVE },
        data: expect.objectContaining({
          status: StreamStatus.LOCKED,
          endedReason: StreamEndReason.LOCKED,
          lockedById: 'admin-1',
          lockedReason: 'Graphic violence',
          lockedAt: expect.any(Date),
        }),
      });
      expect(events.emit.mock.calls.map(([name]) => name)).toEqual([
        'stream.locked',
        'stream.ended',
      ]);
      expect(events.emit).toHaveBeenCalledWith('stream.locked', {
        streamId: 's1',
        hostId: 'host-1',
        actorId: 'admin-1',
        reason: 'Graphic violence',
      });
      expect(events.emit).toHaveBeenCalledWith('stream.ended', {
        streamId: 's1',
        reason: StreamEndReason.LOCKED,
        message: 'Graphic violence',
      });
      expect(videoProvider.closeChannel).toHaveBeenCalledWith('stream_s1');
    });

    it('refuses to lock a live that is not running', async () => {
      prisma.stream.findUnique.mockResolvedValue({ ...live, status: StreamStatus.ENDED });

      await expect(makeService().lock('s1', 'admin-1', 'Spam')).rejects.toThrow(ConflictException);
      expect(prisma.stream.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('announces nothing when the live ended in the meantime', async () => {
      prisma.stream.findUnique.mockResolvedValue(live);
      prisma.stream.updateMany.mockResolvedValue({ count: 0 });

      await expect(makeService().lock('s1', 'admin-1', 'Spam')).rejects.toThrow(ConflictException);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('unlocking clears the lock flag and leaves the live over', async () => {
      prisma.stream.findUnique.mockResolvedValue({ ...live, status: StreamStatus.ENDED });

      await makeService().unlock('s1', 'admin-1');

      expect(prisma.stream.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', status: StreamStatus.LOCKED },
        data: { status: StreamStatus.ENDED },
      });
      expect(events.emit).toHaveBeenCalledWith('stream.unlocked', {
        streamId: 's1',
        actorId: 'admin-1',
        hostId: 'host-1',
      });
    });

    it('unlocking tells a live that is not locked apart from one that does not exist', async () => {
      prisma.stream.updateMany.mockResolvedValue({ count: 0 });
      prisma.stream.findUnique.mockResolvedValueOnce({ ...live, status: StreamStatus.ENDED });
      await expect(makeService().unlock('s1', 'admin-1')).rejects.toThrow(ConflictException);

      prisma.stream.findUnique.mockResolvedValueOnce(null);
      await expect(makeService().unlock('missing', 'admin-1')).rejects.toThrow(NotFoundException);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('locks every running live of a suspended host and counts them', async () => {
      prisma.stream.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      prisma.stream.findUnique.mockResolvedValue(live);
      prisma.stream.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const locked = await makeService().lockLiveStreamsOfHost(
        'host-1',
        'admin-1',
        'Account suspended',
      );

      expect(prisma.stream.findMany).toHaveBeenCalledWith({
        where: { hostId: 'host-1', status: StreamStatus.LIVE },
        select: { id: true },
      });
      expect(locked).toBe(1);
    });
  });

  describe('room bans', () => {
    beforeEach(() => {
      prisma.stream.findUnique.mockResolvedValue({ id: 's1', hostId: 'host-1' });
    });

    it('lets the host ban a participant', async () => {
      const service = makeService();

      await service.banFromRoom('s1', 'host-1', 'troll-1', RoomBanScope.SESSION);

      expect(roomBans.ban).toHaveBeenCalledWith(
        'host-1',
        'troll-1',
        RoomBanScope.SESSION,
        's1',
        'host-1',
      );
    });

    it('lets a moderator holding BAN_USERS ban a participant', async () => {
      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.BAN_USERS],
      });
      const service = makeService();

      await service.banFromRoom('s1', 'mod-1', 'troll-1', RoomBanScope.HOST_PERMANENT);

      expect(roomBans.ban).toHaveBeenCalledWith(
        'host-1',
        'troll-1',
        RoomBanScope.HOST_PERMANENT,
        's1',
        'mod-1',
      );
    });

    it('rejects a viewer without the BAN_USERS capability', async () => {
      const service = makeService();

      await expect(
        service.banFromRoom('s1', 'viewer-1', 'troll-1', RoomBanScope.SESSION),
      ).rejects.toThrow(ForbiddenException);
      expect(roomBans.ban).not.toHaveBeenCalled();
    });

    it('lets the host lift a ban', async () => {
      const service = makeService();

      await service.unbanFromRoom('s1', 'host-1', 'troll-1');

      expect(roomBans.unban).toHaveBeenCalledWith('host-1', 'troll-1', 's1', 'host-1');
    });

    it('rejects lifting a ban without the BAN_USERS capability', async () => {
      const service = makeService();

      await expect(service.unbanFromRoom('s1', 'viewer-1', 'troll-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(roomBans.unban).not.toHaveBeenCalled();
    });

    it('never lets a moderator ban or unban another moderator - only the host can', async () => {
      moderators.findActiveGrant.mockResolvedValue({
        capabilities: [ModeratorCapability.BAN_USERS],
      });
      moderators.isActiveModerator.mockResolvedValue(true);

      await expect(
        makeService().banFromRoom('s1', 'mod-1', 'mod-2', RoomBanScope.SESSION),
      ).rejects.toMatchObject({
        response: { code: 'TARGET_IS_MODERATOR' },
      });
      await expect(makeService().unbanFromRoom('s1', 'mod-1', 'mod-2')).rejects.toThrow(
        ForbiddenException,
      );
      expect(moderators.isActiveModerator).toHaveBeenCalledWith('s1', 'mod-2');
      expect(roomBans.ban).not.toHaveBeenCalled();
      expect(roomBans.unban).not.toHaveBeenCalled();

      await makeService().banFromRoom('s1', 'host-1', 'mod-2', RoomBanScope.SESSION);
      expect(roomBans.ban).toHaveBeenCalledWith(
        'host-1',
        'mod-2',
        RoomBanScope.SESSION,
        's1',
        'host-1',
      );
      moderators.findActiveGrant.mockResolvedValue(null);
      moderators.isActiveModerator.mockResolvedValue(false);
    });

    it('refuses to ban the host, or yourself', async () => {
      await expect(
        makeService().banFromRoom('s1', 'host-1', 'host-1', RoomBanScope.SESSION),
      ).rejects.toThrow(BadRequestException);
      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.BAN_USERS],
      });
      await expect(
        makeService().banFromRoom('s1', 'mod-1', 'mod-1', RoomBanScope.SESSION),
      ).rejects.toThrow(BadRequestException);
      expect(roomBans.ban).not.toHaveBeenCalled();
    });
  });

  describe('room chat mute (plan §6.7)', () => {
    beforeEach(() => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'troll-1' });
      moderators.findActiveGrant.mockReset().mockResolvedValue(null);
    });

    it('lets the host mute someone for a while', async () => {
      jest.useFakeTimers({ now: new Date('2026-09-27T12:00:00Z') });
      try {
        const result = await makeService().muteChat('s1', 'host-1', 'troll-1', 300);

        const until = new Date('2026-09-27T12:05:00Z');
        expect(roomChatMutes.mute).toHaveBeenCalledWith('s1', 'troll-1', 'host-1', until);
        expect(result).toEqual({ ok: true, mutedUntil: until });
      } finally {
        jest.useRealTimers();
      }
    });

    it('mutes until the live ends when no duration is given', async () => {
      await makeService().muteChat('s1', 'host-1', 'troll-1');

      expect(roomChatMutes.mute).toHaveBeenCalledWith('s1', 'troll-1', 'host-1', null);
    });

    it('lets a MUTE_CHAT moderator mute, but not a moderator without it', async () => {
      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.MUTE_CHAT],
      });
      await makeService().muteChat('s1', 'mod-1', 'troll-1');
      expect(roomChatMutes.mute).toHaveBeenCalledWith('s1', 'troll-1', 'mod-1', null);

      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.BAN_USERS],
      });
      await expect(makeService().muteChat('s1', 'mod-2', 'troll-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses to mute the host, or yourself', async () => {
      await expect(makeService().muteChat('s1', 'host-1', 'host-1')).rejects.toThrow(
        BadRequestException,
      );
      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.MUTE_CHAT],
      });
      await expect(makeService().muteChat('s1', 'mod-1', 'mod-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(roomChatMutes.mute).not.toHaveBeenCalled();
    });

    it('never lets a moderator mute or unmute another moderator', async () => {
      moderators.findActiveGrant.mockResolvedValue({
        capabilities: [ModeratorCapability.MUTE_CHAT],
      });
      moderators.isActiveModerator.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      await expect(makeService().muteChat('s1', 'mod-1', 'mod-2')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(makeService().unmuteChat('s1', 'mod-1', 'mod-2')).rejects.toThrow(
        ForbiddenException,
      );
      expect(roomChatMutes.mute).not.toHaveBeenCalled();
      expect(roomChatMutes.unmute).not.toHaveBeenCalled();
    });

    it('404s for a user that does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(makeService().muteChat('s1', 'host-1', 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lets the host lift a mute and see who is muted - a plain viewer can do neither', async () => {
      roomChatMutes.listActive.mockResolvedValue({ items: [] });

      await makeService().unmuteChat('s1', 'host-1', 'troll-1');
      expect(roomChatMutes.unmute).toHaveBeenCalledWith('s1', 'troll-1', 'host-1');
      await expect(makeService().listChatMutes('s1', 'host-1')).resolves.toEqual({ items: [] });

      await expect(makeService().unmuteChat('s1', 'viewer-1', 'troll-1')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(makeService().listChatMutes('s1', 'viewer-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('recording permission', () => {
    beforeEach(() => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'fan-1' });
      moderators.findActiveGrant.mockReset().mockResolvedValue(null);
    });

    it('lets the host allow a viewer to record, take it back, and see who may', async () => {
      recordingPermissions.list.mockResolvedValue({ items: [] });

      await expect(makeService().allowRecording('s1', 'host-1', 'fan-1')).resolves.toEqual({
        ok: true,
      });
      expect(recordingPermissions.allow).toHaveBeenCalledWith('s1', 'fan-1', 'host-1');
      await expect(makeService().disallowRecording('s1', 'host-1', 'fan-1')).resolves.toEqual({
        ok: true,
      });
      expect(recordingPermissions.disallow).toHaveBeenCalledWith('s1', 'fan-1', 'host-1');
      await expect(makeService().listRecordingPermissions('s1', 'host-1')).resolves.toEqual({
        items: [],
      });
    });

    it('is the host alone - not even a moderator may', async () => {
      moderators.findActiveGrant.mockResolvedValue({
        capabilities: Object.values(ModeratorCapability),
      });

      await expect(makeService().allowRecording('s1', 'mod-1', 'fan-1')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(makeService().disallowRecording('s1', 'mod-1', 'fan-1')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(makeService().listRecordingPermissions('s1', 'viewer-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(recordingPermissions.allow).not.toHaveBeenCalled();
      expect(recordingPermissions.disallow).not.toHaveBeenCalled();
    });

    it('needs no permission for the host, a live that is on, and someone real', async () => {
      await expect(makeService().allowRecording('s1', 'host-1', 'host-1')).rejects.toThrow(
        BadRequestException,
      );

      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(makeService().allowRecording('s1', 'host-1', 'ghost')).rejects.toThrow(
        NotFoundException,
      );

      prisma.stream.findUnique.mockResolvedValueOnce({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.ENDED,
      });
      await expect(makeService().allowRecording('s1', 'host-1', 'fan-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(recordingPermissions.allow).not.toHaveBeenCalled();
    });
  });

  describe('guest mic mute (plan §6.7)', () => {
    beforeEach(() => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
      });
      moderators.findActiveGrant.mockReset().mockResolvedValue(null);
    });

    it('lets the host, or a FORCE_MUTE_GUESTS moderator, lock and release a guest mic', async () => {
      await makeService().setGuestMicForceMuted('s1', 'host-1', 'g1', true);
      expect(guests.setMicForceMuted).toHaveBeenCalledWith('s1', 'g1', 'host-1', true);

      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.FORCE_MUTE_GUESTS],
      });
      await makeService().setGuestMicForceMuted('s1', 'mod-1', 'g1', false);
      expect(guests.setMicForceMuted).toHaveBeenCalledWith('s1', 'g1', 'mod-1', false);
    });

    it('refuses anyone else', async () => {
      await expect(
        makeService().setGuestMicForceMuted('s1', 'viewer-1', 'g1', true),
      ).rejects.toThrow(ForbiddenException);
      expect(guests.setMicForceMuted).not.toHaveBeenCalled();
    });

    it("never lets a moderator lock another moderator's mic", async () => {
      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.FORCE_MUTE_GUESTS],
      });
      moderators.isActiveModerator.mockResolvedValueOnce(true);

      await expect(
        makeService().setGuestMicForceMuted('s1', 'mod-1', 'mod-2', true),
      ).rejects.toThrow(ForbiddenException);
      expect(guests.setMicForceMuted).not.toHaveBeenCalled();
    });

    it('lets a moderator turn their own mic back on after the host locked it, whatever they were granted', async () => {
      moderators.isActiveModerator.mockResolvedValueOnce(true);

      await makeService().setGuestMicForceMuted('s1', 'mod-1', 'mod-1', false);

      expect(guests.setMicForceMuted).toHaveBeenCalledWith('s1', 'mod-1', 'mod-1', false);
      expect(moderators.findActiveGrant).not.toHaveBeenCalled();
    });

    it("but a plain guest can't, and a moderator can't lock their own or lift anyone else's without the capability", async () => {
      await expect(makeService().setGuestMicForceMuted('s1', 'g1', 'g1', false)).rejects.toThrow(
        ForbiddenException,
      );

      const chatOnly = { capabilities: [ModeratorCapability.DELETE_MESSAGES] };
      moderators.findActiveGrant.mockResolvedValueOnce(chatOnly).mockResolvedValueOnce(chatOnly);
      await expect(
        makeService().setGuestMicForceMuted('s1', 'mod-1', 'mod-1', true),
      ).rejects.toThrow(ForbiddenException);
      await expect(makeService().setGuestMicForceMuted('s1', 'mod-1', 'g1', false)).rejects.toThrow(
        ForbiddenException,
      );
      expect(guests.setMicForceMuted).not.toHaveBeenCalled();
    });
  });

  describe('arranging guests on the stage', () => {
    const spot = { x: 0.2, y: 1, size: 0.35 };

    beforeEach(() => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
      });
      moderators.findActiveGrant.mockReset().mockResolvedValue(null);
    });

    it('lets the host, or an ARRANGE_GUESTS moderator, move a tile or put it back in line', async () => {
      await makeService().setGuestPlacement('s1', 'host-1', 'g1', spot);
      expect(guests.setPlacement).toHaveBeenCalledWith('s1', 'g1', 'host-1', spot);

      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.ARRANGE_GUESTS],
      });
      await makeService().setGuestPlacement('s1', 'mod-1', 'g1', null);
      expect(guests.setPlacement).toHaveBeenCalledWith('s1', 'g1', 'mod-1', null);
    });

    it('refuses a viewer, and a moderator without the ability', async () => {
      await expect(makeService().setGuestPlacement('s1', 'viewer-1', 'g1', spot)).rejects.toThrow(
        ForbiddenException,
      );
      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.REMOVE_GUESTS],
      });
      await expect(makeService().setGuestPlacement('s1', 'mod-1', 'g1', spot)).rejects.toThrow(
        ForbiddenException,
      );
      expect(guests.setPlacement).not.toHaveBeenCalled();
    });

    it('only while live', async () => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.ENDED,
      });

      await expect(makeService().setGuestPlacement('s1', 'host-1', 'g1', spot)).rejects.toThrow(
        NotFoundException,
      );
      expect(guests.setPlacement).not.toHaveBeenCalled();
    });
  });

  describe('the full stage (spotlight)', () => {
    beforeEach(() => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
      });
      moderators.findActiveGrant.mockReset().mockResolvedValue(null);
    });

    it('lets the host, or an ARRANGE_GUESTS moderator, put a guest on it or give it back', async () => {
      await makeService().setSpotlight('s1', 'host-1', 'g1');
      expect(guests.setSpotlight).toHaveBeenCalledWith('s1', 'g1', 'host-1');

      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.ARRANGE_GUESTS],
      });
      await makeService().setSpotlight('s1', 'mod-1', null);
      expect(guests.setSpotlight).toHaveBeenCalledWith('s1', null, 'mod-1');
    });

    it('refuses a viewer, a guest, and a moderator without the ability', async () => {
      await expect(makeService().setSpotlight('s1', 'viewer-1', 'g1')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(makeService().setSpotlight('s1', 'g1', 'g1')).rejects.toThrow(
        ForbiddenException,
      );
      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.REMOVE_GUESTS],
      });
      await expect(makeService().setSpotlight('s1', 'mod-1', null)).rejects.toThrow(
        ForbiddenException,
      );
      expect(guests.setSpotlight).not.toHaveBeenCalled();
    });

    it('only while live', async () => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.ENDED,
      });

      await expect(makeService().setSpotlight('s1', 'host-1', 'g1')).rejects.toThrow(
        NotFoundException,
      );
      expect(guests.setSpotlight).not.toHaveBeenCalled();
    });

    it('tells the realtime gateway who may arrange a running live', async () => {
      prisma.stream.findFirst.mockResolvedValue({ id: 's1', hostId: 'host-1', layout: 'FULL' });
      await expect(makeService().canArrangeStage('s1', 'host-1')).resolves.toBe(true);
      await expect(makeService().canArrangeStage('s1', 'viewer-1')).resolves.toBe(false);
      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.ARRANGE_GUESTS],
      });
      await expect(makeService().canArrangeStage('s1', 'mod-1')).resolves.toBe(true);

      prisma.stream.findFirst.mockResolvedValue(null);
      await expect(makeService().canArrangeStage('s1', 'host-1')).resolves.toBe(false);
    });
  });

  describe('post-live summary (plan §6.13)', () => {
    it("gives the host an ended live's stored numbers and who followed them during it", async () => {
      const startedAt = new Date('2026-09-27T10:00:00Z');
      const endedAt = new Date('2026-09-27T11:30:05Z');
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.ENDED,
        startedAt,
        endedAt,
        peakViewerCount: 42,
        likeCount: 1300,
      });
      prisma.follow.count.mockResolvedValue(7);

      await expect(makeService().summary('s1', 'host-1')).resolves.toEqual({
        streamId: 's1',
        durationSeconds: 5405,
        peakViewerCount: 42,
        likeCount: 1300,
        newFollowers: 7,
      });
      expect(prisma.follow.count).toHaveBeenCalledWith({
        where: { followeeId: 'host-1', createdAt: { gte: startedAt, lte: endedAt } },
      });
      expect(presence.peakViewerCount).not.toHaveBeenCalled();
    });

    it('reads the running numbers from presence while still live', async () => {
      jest.useFakeTimers({ now: new Date('2026-09-27T10:10:00Z') });
      try {
        prisma.stream.findUnique.mockResolvedValue({
          id: 's1',
          hostId: 'host-1',
          status: StreamStatus.LIVE,
          visibility: StreamVisibility.PUBLIC,
          startedAt: new Date('2026-09-27T10:00:00Z'),
          endedAt: null,
          peakViewerCount: 0,
          likeCount: 0,
        });
        presence.peakViewerCount.mockResolvedValueOnce(9);
        presence.likeCount.mockResolvedValueOnce(55);
        prisma.follow.count.mockResolvedValue(2);

        await expect(makeService().summary('s1', 'host-1')).resolves.toMatchObject({
          durationSeconds: 600,
          peakViewerCount: 9,
          likeCount: 55,
          newFollowers: 2,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('is only for the host', async () => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.ENDED,
        startedAt: new Date(),
        endedAt: new Date(),
      });

      await expect(makeService().summary('s1', 'viewer-1')).rejects.toThrow(ForbiddenException);
      expect(prisma.follow.count).not.toHaveBeenCalled();
    });
  });

  describe('moderator management (scoped to one stream, plan §6.9)', () => {
    beforeEach(() => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
      });
    });

    it('lets the host grant a moderator for this stream only while live', async () => {
      const service = makeService();

      await service.grantModerator('s1', 'host-1', 'u1', [ModeratorCapability.PIN_MESSAGES]);

      expect(moderators.grant).toHaveBeenCalledWith('host-1', 's1', 'u1', [
        ModeratorCapability.PIN_MESSAGES,
      ]);
    });

    it('refuses to grant a moderator for a stream that is not live', async () => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.ENDED,
      });
      const service = makeService();

      await expect(
        service.grantModerator('s1', 'host-1', 'u1', [ModeratorCapability.PIN_MESSAGES]),
      ).rejects.toThrow(NotFoundException);
      expect(moderators.grant).not.toHaveBeenCalled();
    });

    it('refuses to let anyone but the host grant a moderator', async () => {
      const service = makeService();

      await expect(
        service.grantModerator('s1', 'viewer-1', 'u1', [ModeratorCapability.PIN_MESSAGES]),
      ).rejects.toThrow(ForbiddenException);
      expect(moderators.grant).not.toHaveBeenCalled();
    });

    it('refuses to let a moderator grant another moderator', async () => {
      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.BAN_USERS],
      });
      const service = makeService();

      await expect(
        service.grantModerator('s1', 'mod-1', 'u1', [ModeratorCapability.PIN_MESSAGES]),
      ).rejects.toThrow(ForbiddenException);
      expect(moderators.grant).not.toHaveBeenCalled();
    });

    it("lets the host edit an existing moderator's capabilities", async () => {
      const service = makeService();

      await service.updateModerator('s1', 'host-1', 'u1', [ModeratorCapability.BAN_USERS]);

      expect(moderators.updateCapabilities).toHaveBeenCalledWith('s1', 'u1', [
        ModeratorCapability.BAN_USERS,
      ]);
    });

    it('lets the host revoke a moderator', async () => {
      const service = makeService();

      await service.revokeModerator('s1', 'host-1', 'u1');

      expect(moderators.revoke).toHaveBeenCalledWith('s1', 'u1');
    });

    it('refuses to let anyone but the host list, edit, or revoke moderators', async () => {
      const service = makeService();

      await expect(service.listModerators('s1', 'viewer-1')).rejects.toThrow(ForbiddenException);
      await expect(
        service.updateModerator('s1', 'viewer-1', 'u1', [ModeratorCapability.BAN_USERS]),
      ).rejects.toThrow(ForbiddenException);
      await expect(service.revokeModerator('s1', 'viewer-1', 'u1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(moderators.updateCapabilities).not.toHaveBeenCalled();
      expect(moderators.revoke).not.toHaveBeenCalled();
    });

    it('lets the host list active moderators for this stream', async () => {
      moderators.list.mockResolvedValueOnce({ items: [] });
      const service = makeService();

      await service.listModerators('s1', 'host-1');

      expect(moderators.list).toHaveBeenCalledWith('s1');
    });
  });

  describe('viewer list', () => {
    it('paginates viewers hydrated from presence', async () => {
      prisma.stream.findFirst.mockResolvedValue({ id: 's1' });
      presence.viewerIds.mockResolvedValueOnce(['a', 'b', 'c']);
      prisma.user.findMany.mockResolvedValueOnce([
        { id: 'b', username: 'b', displayName: 'B', avatarUrl: null },
        { id: 'a', username: 'a', displayName: 'A', avatarUrl: null },
      ]);
      const service = makeService();

      const result = await service.listViewers('s1', 'me', undefined, 2);

      expect(result.items.map((item) => item.id)).toEqual(['a', 'b']);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe('b');
    });

    it('leaves out anyone blocked either way with the requester', async () => {
      prisma.stream.findFirst.mockResolvedValue({ id: 's1' });
      presence.viewerIds.mockResolvedValueOnce(['c', 'blocked', 'a']);
      social.blockedEitherWayUserIds.mockResolvedValueOnce(['blocked']);
      prisma.user.findMany.mockResolvedValueOnce([]);
      const service = makeService();

      const result = await service.listViewers('s1', 'me');

      expect(social.blockedEitherWayUserIds).toHaveBeenCalledWith('me');
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['a', 'c'] } } }),
      );
      expect(result).toMatchObject({ hasMore: false, nextCursor: null });
    });

    it('404s when the stream is not live', async () => {
      prisma.stream.findFirst.mockResolvedValue(null);
      const service = makeService();

      await expect(service.listViewers('s1', 'me')).rejects.toThrow(NotFoundException);
    });
  });

  describe('a block during a running live (plan §6.4)', () => {
    const live = {
      id: 's1',
      hostId: 'host',
      status: StreamStatus.LIVE,
      visibility: StreamVisibility.PUBLIC,
      videoProvider: VideoProviderKind.LIVEKIT,
      channelName: 'stream_s1',
    };

    it('takes whoever the host blocked out of the live, and says the host removed them', async () => {
      prisma.stream.findMany.mockResolvedValueOnce([live]);

      await makeService().handleUserBlocked({ blockerId: 'host', blockedId: 'viewer' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith({
        where: { status: StreamStatus.LIVE, hostId: { in: ['host', 'viewer'] } },
      });
      expect(videoProvider.revokeToken).toHaveBeenCalledWith('stream_s1', 'viewer');
      expect(events.emit).toHaveBeenCalledWith('live.access_revoked', {
        streamId: 's1',
        hostId: 'host',
        userId: 'viewer',
        removedByHost: true,
      });
    });

    it('takes someone who blocked the host out of their live too', async () => {
      prisma.stream.findMany.mockResolvedValueOnce([live]);

      await makeService().handleUserBlocked({ blockerId: 'viewer', blockedId: 'host' });

      expect(videoProvider.revokeToken).toHaveBeenCalledWith('stream_s1', 'viewer');
      expect(events.emit).toHaveBeenCalledWith(
        'live.access_revoked',
        expect.objectContaining({ userId: 'viewer', removedByHost: false }),
      );
    });

    it('gets a blocked guest off the stage first', async () => {
      prisma.stream.findMany.mockResolvedValueOnce([live]);
      guests.isActiveGuest.mockResolvedValueOnce(true);

      await makeService().handleUserBlocked({ blockerId: 'host', blockedId: 'guest' });

      expect(guests.remove).toHaveBeenCalledWith('s1', 'host', 'guest', true, 'host');
    });

    it('does nothing when neither of them is live', async () => {
      prisma.stream.findMany.mockResolvedValueOnce([]);

      await makeService().handleUserBlocked({ blockerId: 'a', blockedId: 'b' });

      expect(videoProvider.revokeToken).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('mention suggestions', () => {
    const person = (id: string) => ({
      id,
      username: id,
      displayName: id.toUpperCase(),
      avatarUrl: null,
    });

    beforeEach(() => {
      prisma.stream.findFirst.mockResolvedValue({ id: 's1', hostId: 'host' });
      presence.viewerIds.mockResolvedValue(['me', 'ana', 'blocked', 'host']);
      social.blockedEitherWayUserIds.mockResolvedValue(['blocked']);
    });

    it('puts the host first, then whoever is watching - never yourself or anyone blocked either way', async () => {
      prisma.user.findFirst.mockResolvedValue(person('host'));
      prisma.user.findMany.mockResolvedValueOnce([person('ana')]);

      const result = await makeService().mentionSuggestions('s1', 'me', ' an ', 5);

      expect(result.items.map((item) => item.id)).toEqual(['host', 'ana']);
      const match = {
        status: UserStatus.ACTIVE,
        OR: [
          { username: { startsWith: 'an', mode: 'insensitive' } },
          { displayName: { startsWith: 'an', mode: 'insensitive' } },
        ],
      };
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'host', ...match } }),
      );
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['ana'] }, ...match },
          orderBy: { username: 'asc' },
          take: 5,
        }),
      );
    });

    it("doesn't suggest the host to themselves, and lists everyone for a bare @", async () => {
      prisma.user.findMany.mockResolvedValueOnce([person('ana'), person('me')]);

      const result = await makeService().mentionSuggestions('s1', 'host');

      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['me', 'ana'] }, status: UserStatus.ACTIVE },
        }),
      );
      expect(result.items).toHaveLength(2);
    });

    it('404s when the stream is not live', async () => {
      prisma.stream.findFirst.mockResolvedValue(null);

      await expect(makeService().mentionSuggestions('s1', 'me', 'a')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('guest management (plan §6.5/§6.6)', () => {
    beforeEach(() => {
      prisma.stream.findUnique.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
        videoProvider: VideoProviderKind.LIVEKIT,
        channelName: 'stream_s1',
      });
      // A previous describe block may have left a queued
      // mockResolvedValueOnce() unconsumed (e.g. a test whose code path
      // short-circuited via isHost before ever calling findActiveGrant) -
      // mockReset() (not just mockResolvedValue()) clears that queue too,
      // so this block never inherits it.
      moderators.findActiveGrant.mockReset().mockResolvedValue(null);
    });

    it('lets a viewer request to join, after checking they are not banned', async () => {
      guests.request.mockResolvedValue({ id: 'req-1' });
      const service = makeService();

      await service.requestToJoinAsGuest('s1', 'viewer-1');

      expect(roomBans.isBanned).toHaveBeenCalledWith('host-1', 'viewer-1', 's1');
      expect(guests.request).toHaveBeenCalledWith('s1', 'host-1', 'viewer-1');
    });

    it('refuses to let a banned viewer request to join', async () => {
      roomBans.isBanned.mockResolvedValueOnce(true);
      const service = makeService();

      await expect(service.requestToJoinAsGuest('s1', 'viewer-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(guests.request).not.toHaveBeenCalled();
    });

    it('has no stage to offer someone blocked either way with the host', async () => {
      social.isBlockedEitherWay.mockResolvedValueOnce(true);
      const service = makeService();

      await expect(service.requestToJoinAsGuest('s1', 'viewer-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(guests.request).not.toHaveBeenCalled();
    });

    it('lets only the host invite someone on stage', async () => {
      const service = makeService();

      await service.inviteGuest('s1', 'host-1', 'u1');
      expect(guests.invite).toHaveBeenCalledWith('s1', 'host-1', 'u1');

      await expect(service.inviteGuest('s1', 'viewer-1', 'u1')).rejects.toThrow(ForbiddenException);
    });

    it('delegates cancelling a request straight to GuestsService, which owns the authorization', async () => {
      const service = makeService();

      await service.cancelGuestRequest('s1', 'req-1', 'viewer-1');

      expect(guests.cancel).toHaveBeenCalledWith('s1', 'req-1', 'viewer-1', 'host-1');
    });

    it('lets the host or a MANAGE_GUEST_REQUESTS moderator list pending requests', async () => {
      guests.listPending.mockResolvedValue({ items: [] });
      const service = makeService();

      await service.listGuestRequests('s1', 'host-1');
      expect(guests.listPending).toHaveBeenCalledWith('s1');

      moderators.findActiveGrant.mockResolvedValue({
        capabilities: [ModeratorCapability.MANAGE_GUEST_REQUESTS],
      });
      await service.listGuestRequests('s1', 'mod-1');

      moderators.findActiveGrant.mockResolvedValue({
        capabilities: [ModeratorCapability.BAN_USERS],
      });
      await expect(service.listGuestRequests('s1', 'mod-2')).rejects.toThrow(ForbiddenException);
    });

    it('accepting mints a fresh publisher token and hands it to GuestsService', async () => {
      guests.findPendingOrThrow.mockResolvedValue({
        id: 'req-1',
        streamId: 's1',
        userId: 'u1',
        initiatedBy: 'VIEWER',
      });
      const service = makeService();

      await service.acceptGuestRequest('s1', 'req-1', 'host-1');

      expect(videoProvider.mintToken).toHaveBeenCalledWith(
        expect.objectContaining({ channelName: 'stream_s1', userId: 'u1', role: 'publisher' }),
      );
      expect(guests.accept).toHaveBeenCalledWith(
        's1',
        'req-1',
        expect.objectContaining({ provider: VideoProviderKind.LIVEKIT }),
      );
    });

    it('refuses to accept once the stream already has the maximum number of guests', async () => {
      guests.findPendingOrThrow.mockResolvedValue({
        id: 'req-1',
        streamId: 's1',
        userId: 'u1',
        initiatedBy: 'VIEWER',
      });
      guests.countActiveGuests.mockResolvedValueOnce(6);
      const service = makeService();

      await expect(service.acceptGuestRequest('s1', 'req-1', 'host-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(guests.accept).not.toHaveBeenCalled();
    });

    it('only lets the invitee accept or reject a HOST-initiated invite, not the host or a moderator', async () => {
      guests.findPendingOrThrow.mockResolvedValue({
        id: 'req-1',
        streamId: 's1',
        userId: 'u1',
        initiatedBy: 'HOST',
      });
      const service = makeService();

      await expect(service.acceptGuestRequest('s1', 'req-1', 'host-1')).rejects.toThrow(
        ForbiddenException,
      );
      await service.acceptGuestRequest('s1', 'req-1', 'u1');
      expect(guests.accept).toHaveBeenCalled();
    });

    it('only lets the host or a moderator accept/reject a VIEWER-initiated request, not the requester', async () => {
      guests.findPendingOrThrow.mockResolvedValue({
        id: 'req-1',
        streamId: 's1',
        userId: 'viewer-1',
        initiatedBy: 'VIEWER',
      });
      moderators.findActiveGrant.mockResolvedValue(null);
      const service = makeService();

      await expect(service.rejectGuestRequest('s1', 'req-1', 'viewer-1')).rejects.toThrow(
        ForbiddenException,
      );
      await service.rejectGuestRequest('s1', 'req-1', 'host-1');
      expect(guests.reject).toHaveBeenCalledWith('s1', 'req-1');
    });

    it('removing a guest needs REMOVE_GUESTS and revokes their media before freeing the seat', async () => {
      guests.isActiveGuest.mockResolvedValueOnce(true);
      const service = makeService();

      await service.removeGuest('s1', 'host-1', 'u1');

      expect(videoProvider.revokeToken).toHaveBeenCalledWith('stream_s1', 'u1');
      expect(guests.remove).toHaveBeenCalledWith('s1', 'host-1', 'u1', true, 'host-1');
      expect(videoProvider.revokeToken.mock.invocationCallOrder[0]).toBeLessThan(
        guests.remove.mock.invocationCallOrder[0],
      );
    });

    it('still frees the seat when the media revoke fails', async () => {
      guests.isActiveGuest.mockResolvedValueOnce(true);
      videoProvider.revokeToken.mockRejectedValueOnce(new Error('LiveKit down'));
      const service = makeService();

      await service.removeGuest('s1', 'host-1', 'u1');

      expect(guests.remove).toHaveBeenCalledWith('s1', 'host-1', 'u1', true, 'host-1');
    });

    it('never revokes the media of someone who is not seated (a plain viewer)', async () => {
      const service = makeService();

      await service.removeGuest('s1', 'host-1', 'u1');

      expect(videoProvider.revokeToken).not.toHaveBeenCalled();
      expect(guests.remove).not.toHaveBeenCalled();
    });

    it('refuses to let a viewer without REMOVE_GUESTS remove a guest', async () => {
      const service = makeService();

      await expect(service.removeGuest('s1', 'viewer-1', 'u1')).rejects.toThrow(ForbiddenException);
      expect(guests.remove).not.toHaveBeenCalled();
    });

    it('never lets a moderator take another moderator off the stage', async () => {
      moderators.findActiveGrant.mockResolvedValueOnce({
        capabilities: [ModeratorCapability.REMOVE_GUESTS],
      });
      moderators.isActiveModerator.mockResolvedValueOnce(true);

      await expect(makeService().removeGuest('s1', 'mod-1', 'mod-2')).rejects.toThrow(
        ForbiddenException,
      );
      expect(videoProvider.revokeToken).not.toHaveBeenCalled();
      expect(guests.remove).not.toHaveBeenCalled();
    });

    it('leaving your own seat needs no capability and does not set the removed-by-host flag', async () => {
      guests.isActiveGuest.mockResolvedValueOnce(true);
      const service = makeService();

      await service.leaveGuestSeat('s1', 'u1');

      expect(videoProvider.revokeToken).toHaveBeenCalledWith('stream_s1', 'u1');
      expect(guests.remove).toHaveBeenCalledWith('s1', 'host-1', 'u1', false, 'u1');
    });

    it("join() includes who's already on stage, the viewer's own pending request, and the host's Agora uid", async () => {
      prisma.stream.findFirst.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
      });
      guests.activeGuests.mockResolvedValueOnce([
        { id: 'g1', username: 'g', displayName: 'G', avatarUrl: null, joinedAt: new Date() },
      ]);
      guests.findOwnPending.mockResolvedValueOnce({
        id: 'req-1',
        initiatedBy: 'HOST',
        requestedAt: new Date(),
      });
      const service = makeService();

      const result = await service.join('s1', 'viewer-1');

      expect(result.activeGuests).toHaveLength(1);
      expect(guests.findOwnPending).toHaveBeenCalledWith('s1', 'viewer-1');
      expect(result.selfGuestRequest).toEqual(
        expect.objectContaining({ id: 'req-1', initiatedBy: 'HOST' }),
      );
      expect(result.hostAgoraUid).toEqual(expect.any(Number));
    });

    it('join() frees a seat the viewer still holds (app killed while on stage) before minting their token', async () => {
      prisma.stream.findFirst.mockResolvedValue({
        id: 's1',
        hostId: 'host-1',
        status: StreamStatus.LIVE,
        visibility: StreamVisibility.PUBLIC,
        videoProvider: VideoProviderKind.LIVEKIT,
        channelName: 'stream_s1',
      });
      guests.isActiveGuest.mockResolvedValueOnce(true);
      const service = makeService();

      await service.join('s1', 'viewer-1');

      expect(guests.remove).toHaveBeenCalledWith('s1', 'host-1', 'viewer-1', false, 'viewer-1');
      expect(videoProvider.revokeToken.mock.invocationCallOrder[0]).toBeLessThan(
        videoProvider.mintToken.mock.invocationCallOrder[0],
      );
    });

    it('ending a stream cascades every active guest to removed', async () => {
      prisma.stream.updateMany.mockResolvedValue({ count: 1 });
      const service = makeService();

      await service.end('s1', 'host-1');

      await new Promise(process.nextTick); // not awaited on purpose - see endStream()
      expect(guests.removeAllForEndedStream).toHaveBeenCalledWith('s1');
    });
  });
});
