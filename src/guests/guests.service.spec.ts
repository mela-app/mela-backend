import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  GuestRequestInitiator,
  GuestRequestStatus,
  StreamGuestStatus,
  VideoProviderKind,
} from '@prisma/client';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { agoraUidFor } from '../common/video-provider/agora-video-provider.service';
import { ModeratorsService } from '../moderators/moderators.service';
import { GuestsService } from './guests.service';

const STREAM = 's1';
const HOST = 'host-1';
const USER = { id: 'u1', username: 'u1name', displayName: 'U1', avatarUrl: null };

describe('GuestsService', () => {
  const prisma = {
    guestRequest: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    streamGuest: {
      findUnique: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    user: { findUniqueOrThrow: jest.fn() },
  };
  const redisClient = { exists: jest.fn().mockResolvedValue(0), set: jest.fn() };
  const redis = { getClient: () => redisClient } as unknown as RedisService;
  const events = { emit: jest.fn() };
  const moderators = { listUserIdsWithCapability: jest.fn().mockResolvedValue([]) };

  const service = () =>
    new GuestsService(
      prisma as unknown as PrismaService,
      redis,
      events as never,
      moderators as unknown as ModeratorsService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    redisClient.exists.mockResolvedValue(0);
    moderators.listUserIdsWithCapability.mockResolvedValue([]);
    prisma.guestRequest.findFirst.mockResolvedValue(null);
    prisma.streamGuest.findUnique.mockResolvedValue(null);
  });

  describe('request', () => {
    it('refuses to let the host request to join their own stream', async () => {
      await expect(service().request(STREAM, HOST, HOST)).rejects.toThrow(BadRequestException);
      expect(prisma.guestRequest.create).not.toHaveBeenCalled();
    });

    it('refuses when already an active guest', async () => {
      prisma.streamGuest.findUnique.mockResolvedValue({ status: StreamGuestStatus.ACTIVE });
      await expect(service().request(STREAM, HOST, USER.id)).rejects.toThrow(BadRequestException);
    });

    it('refuses while on the post-removal cooldown', async () => {
      redisClient.exists.mockResolvedValue(1);
      await expect(service().request(STREAM, HOST, USER.id)).rejects.toThrow(ForbiddenException);
    });

    it('refuses a second request while one is already pending', async () => {
      prisma.guestRequest.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(service().request(STREAM, HOST, USER.id)).rejects.toThrow(BadRequestException);
    });

    it('creates a VIEWER-initiated request and notifies the host + eligible moderators', async () => {
      prisma.guestRequest.create.mockResolvedValue({ id: 'req-1', user: USER });
      moderators.listUserIdsWithCapability.mockResolvedValue(['mod-1']);

      const result = await service().request(STREAM, HOST, USER.id);

      expect(result).toEqual({ id: 'req-1' });
      expect(prisma.guestRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { streamId: STREAM, userId: USER.id, initiatedBy: GuestRequestInitiator.VIEWER },
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.GuestRequestCreated, {
        streamId: STREAM,
        requestId: 'req-1',
        initiatedBy: GuestRequestInitiator.VIEWER,
        user: USER,
        recipientIds: [HOST, 'mod-1'],
      });
    });
  });

  describe('invite', () => {
    it('refuses to let the host invite themselves', async () => {
      await expect(service().invite(STREAM, HOST, HOST)).rejects.toThrow(BadRequestException);
    });

    it('creates a HOST-initiated request and notifies only the invitee', async () => {
      prisma.guestRequest.create.mockResolvedValue({ id: 'req-2', user: USER });

      await service().invite(STREAM, HOST, USER.id);

      expect(prisma.guestRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { streamId: STREAM, userId: USER.id, initiatedBy: GuestRequestInitiator.HOST },
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.GuestRequestCreated, {
        streamId: STREAM,
        requestId: 'req-2',
        initiatedBy: GuestRequestInitiator.HOST,
        user: USER,
        recipientIds: [USER.id],
      });
    });
  });

  describe('listPending', () => {
    it('only lists VIEWER-initiated pending requests', async () => {
      prisma.guestRequest.findMany.mockResolvedValue([]);

      await service().listPending(STREAM);

      expect(prisma.guestRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            streamId: STREAM,
            status: GuestRequestStatus.PENDING,
            initiatedBy: GuestRequestInitiator.VIEWER,
          },
        }),
      );
    });
  });

  describe('findOwnPending', () => {
    it("looks up this user's newest open request or invite for the stream, either direction", async () => {
      prisma.guestRequest.findFirst.mockResolvedValue({
        id: 'req-1',
        initiatedBy: GuestRequestInitiator.HOST,
      });

      const result = await service().findOwnPending(STREAM, USER.id);

      expect(result).toEqual({ id: 'req-1', initiatedBy: GuestRequestInitiator.HOST });
      expect(prisma.guestRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { streamId: STREAM, userId: USER.id, status: GuestRequestStatus.PENDING },
          orderBy: { requestedAt: 'desc' },
        }),
      );
    });
  });

  describe('activeGuests', () => {
    it('lists seats oldest first, each with the Agora uid their publisher token uses and its mic lock', async () => {
      const joinedAt = new Date();
      prisma.streamGuest.findMany.mockResolvedValue([
        { joinedAt, micForceMuted: true, stageX: null, stageY: null, stageSize: null, user: USER },
      ]);

      const result = await service().activeGuests(STREAM);

      expect(prisma.streamGuest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { streamId: STREAM, status: StreamGuestStatus.ACTIVE },
          orderBy: { joinedAt: 'asc' },
        }),
      );
      expect(result).toEqual([
        { ...USER, joinedAt, agoraUid: agoraUidFor(USER.id), micForceMuted: true, placement: null },
      ]);
    });

    it('says where the host put a tile', async () => {
      prisma.streamGuest.findMany.mockResolvedValue([
        {
          joinedAt: new Date(),
          micForceMuted: false,
          stageX: 0.1,
          stageY: 0.9,
          stageSize: 0.4,
          user: USER,
        },
      ]);

      const [guest] = await service().activeGuests(STREAM);

      expect(guest.placement).toEqual({ x: 0.1, y: 0.9, size: 0.4 });
    });
  });

  describe('setPlacement', () => {
    it("moves an active guest's tile and tells everyone", async () => {
      prisma.streamGuest.updateMany.mockResolvedValue({ count: 1 });

      await service().setPlacement(STREAM, USER.id, 'mod-1', { x: 0, y: 0.5, size: 0.3 });

      expect(prisma.streamGuest.updateMany).toHaveBeenCalledWith({
        where: { streamId: STREAM, userId: USER.id, status: StreamGuestStatus.ACTIVE },
        data: { stageX: 0, stageY: 0.5, stageSize: 0.3 },
      });
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.GuestPlacementChanged, {
        streamId: STREAM,
        userId: USER.id,
        actorId: 'mod-1',
        placement: { x: 0, y: 0.5, size: 0.3 },
      });
    });

    it('puts the tile back in the automatic column', async () => {
      prisma.streamGuest.updateMany.mockResolvedValue({ count: 1 });

      await service().setPlacement(STREAM, USER.id, HOST, null);

      expect(prisma.streamGuest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { stageX: null, stageY: null, stageSize: null } }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.GuestPlacementChanged,
        expect.objectContaining({ placement: null }),
      );
    });

    it('404s for someone who is not on stage', async () => {
      prisma.streamGuest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service().setPlacement(STREAM, USER.id, HOST, null)).rejects.toThrow(
        NotFoundException,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('setMicForceMuted', () => {
    it("locks an active guest's mic and announces it", async () => {
      prisma.streamGuest.updateMany.mockResolvedValue({ count: 1 });

      await service().setMicForceMuted(STREAM, USER.id, 'mod-1', true);

      expect(prisma.streamGuest.updateMany).toHaveBeenCalledWith({
        where: {
          streamId: STREAM,
          userId: USER.id,
          status: StreamGuestStatus.ACTIVE,
          micForceMuted: false,
        },
        data: { micForceMuted: true },
      });
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.GuestMicForceMuteChanged, {
        streamId: STREAM,
        userId: USER.id,
        actorId: 'mod-1',
        forceMuted: true,
      });
    });

    it('is a quiet no-op when the mic is already that way', async () => {
      prisma.streamGuest.updateMany.mockResolvedValue({ count: 0 });
      prisma.streamGuest.findUnique.mockResolvedValue({ status: StreamGuestStatus.ACTIVE });

      await service().setMicForceMuted(STREAM, USER.id, HOST, false);

      expect(events.emit).not.toHaveBeenCalled();
    });

    it('404s for someone who is not on stage', async () => {
      prisma.streamGuest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service().setMicForceMuted(STREAM, USER.id, HOST, true)).rejects.toThrow(
        NotFoundException,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    const CREDENTIALS = {
      provider: VideoProviderKind.AGORA,
      appId: 'a',
      token: 't',
      uid: 42,
      expiresAt: new Date(),
    } as const;

    it('404s for a request from a different stream', async () => {
      prisma.guestRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        streamId: 'other-stream',
        status: GuestRequestStatus.PENDING,
      });
      await expect(service().accept(STREAM, 'req-1', CREDENTIALS)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses to resolve an already-resolved request', async () => {
      prisma.guestRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        streamId: STREAM,
        status: GuestRequestStatus.ACCEPTED,
      });
      await expect(service().accept(STREAM, 'req-1', CREDENTIALS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('marks the request accepted, upserts an active guest seat, and emits both events', async () => {
      prisma.guestRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        streamId: STREAM,
        userId: USER.id,
        status: GuestRequestStatus.PENDING,
      });
      prisma.user.findUniqueOrThrow.mockResolvedValue(USER);

      await service().accept(STREAM, 'req-1', CREDENTIALS);

      expect(prisma.guestRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'req-1' },
          data: expect.objectContaining({ status: GuestRequestStatus.ACCEPTED }),
        }),
      );
      expect(prisma.streamGuest.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { streamId_userId: { streamId: STREAM, userId: USER.id } },
          // A returning guest starts with their mic allowed again, back in line.
          update: expect.objectContaining({
            status: StreamGuestStatus.ACTIVE,
            micForceMuted: false,
            stageX: null,
            stageY: null,
            stageSize: null,
          }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.GuestRequestAccepted,
        expect.objectContaining({
          streamId: STREAM,
          requestId: 'req-1',
          userId: USER.id,
          credentials: CREDENTIALS,
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.GuestJoined,
        expect.objectContaining({ streamId: STREAM, user: USER, agoraUid: 42 }),
      );
    });

    it('reports a null agoraUid on LiveKit', async () => {
      prisma.guestRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        streamId: STREAM,
        userId: USER.id,
        status: GuestRequestStatus.PENDING,
      });
      prisma.user.findUniqueOrThrow.mockResolvedValue(USER);

      await service().accept(STREAM, 'req-1', {
        provider: VideoProviderKind.LIVEKIT,
        url: 'wss://x',
        token: 't',
        expiresAt: new Date(),
      });

      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.GuestJoined,
        expect.objectContaining({ agoraUid: null }),
      );
    });
  });

  describe('reject', () => {
    it('marks the request rejected and notifies the requester', async () => {
      prisma.guestRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        streamId: STREAM,
        userId: USER.id,
        status: GuestRequestStatus.PENDING,
      });

      await service().reject(STREAM, 'req-1');

      expect(prisma.guestRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: GuestRequestStatus.REJECTED }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.GuestRequestRejected, {
        streamId: STREAM,
        requestId: 'req-1',
        userId: USER.id,
      });
    });
  });

  describe('cancel', () => {
    it('lets the requester cancel their own VIEWER-initiated request', async () => {
      prisma.guestRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        streamId: STREAM,
        userId: USER.id,
        initiatedBy: GuestRequestInitiator.VIEWER,
        status: GuestRequestStatus.PENDING,
      });

      await service().cancel(STREAM, 'req-1', USER.id, HOST);

      expect(prisma.guestRequest.update).toHaveBeenCalled();
    });

    it("refuses to let someone else cancel a viewer's request", async () => {
      prisma.guestRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        streamId: STREAM,
        userId: USER.id,
        initiatedBy: GuestRequestInitiator.VIEWER,
        status: GuestRequestStatus.PENDING,
      });

      await expect(service().cancel(STREAM, 'req-1', 'someone-else', HOST)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lets the host retract their own invite, notifying the invitee', async () => {
      prisma.guestRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        streamId: STREAM,
        userId: USER.id,
        initiatedBy: GuestRequestInitiator.HOST,
        status: GuestRequestStatus.PENDING,
      });

      await service().cancel(STREAM, 'req-1', HOST, HOST);

      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.GuestRequestCancelled,
        expect.objectContaining({
          initiatedBy: GuestRequestInitiator.HOST,
          recipientIds: [USER.id],
        }),
      );
    });

    it("refuses to let the invitee cancel the host's own invite (only the host can retract it)", async () => {
      prisma.guestRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        streamId: STREAM,
        userId: USER.id,
        initiatedBy: GuestRequestInitiator.HOST,
        status: GuestRequestStatus.PENDING,
      });

      await expect(service().cancel(STREAM, 'req-1', USER.id, HOST)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('remove', () => {
    it('is a harmless no-op when there is nothing active to remove', async () => {
      prisma.streamGuest.updateMany.mockResolvedValue({ count: 0 });

      await service().remove(STREAM, HOST, USER.id, true);

      expect(events.emit).not.toHaveBeenCalled();
      expect(redisClient.set).not.toHaveBeenCalled();
    });

    it('sets the removal cooldown and emits when host/moderator-initiated', async () => {
      prisma.streamGuest.updateMany.mockResolvedValue({ count: 1 });

      await service().remove(STREAM, HOST, USER.id, true);

      expect(redisClient.set).toHaveBeenCalledWith(
        `guest_cooldown:${STREAM}:${USER.id}`,
        '1',
        'EX',
        300,
      );
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.GuestRemoved,
        expect.objectContaining({ wasRemovedByHostOrModerator: true }),
      );
    });

    it('does not set a cooldown for a self-initiated leave', async () => {
      prisma.streamGuest.updateMany.mockResolvedValue({ count: 1 });

      await service().remove(STREAM, HOST, USER.id, false);

      expect(redisClient.set).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.GuestRemoved,
        expect.objectContaining({ wasRemovedByHostOrModerator: false }),
      );
    });
  });

  describe('removeAllForEndedStream', () => {
    it('bulk-removes every active guest with no per-guest events', async () => {
      await service().removeAllForEndedStream(STREAM);

      expect(prisma.streamGuest.updateMany).toHaveBeenCalledWith({
        where: { streamId: STREAM, status: StreamGuestStatus.ACTIVE },
        data: expect.objectContaining({ status: StreamGuestStatus.REMOVED }),
      });
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
