import { RoomBanScope } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RoomBansService } from './room-bans.service';

describe('RoomBansService', () => {
  const prisma = {
    roomBan: { create: jest.fn(), deleteMany: jest.fn(), findFirst: jest.fn() },
  };
  const events = { emit: jest.fn() };

  const service = () => new RoomBansService(prisma as unknown as PrismaService, events as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.roomBan.deleteMany.mockResolvedValue({ count: 1 });
  });

  describe('ban', () => {
    it('stores the streamId for a session ban and emits it', async () => {
      await service().ban('host-1', 'troll-1', RoomBanScope.SESSION, 's1');

      expect(prisma.roomBan.create).toHaveBeenCalledWith({
        data: { hostId: 'host-1', bannedUserId: 'troll-1', scope: RoomBanScope.SESSION, streamId: 's1' },
      });
      expect(events.emit).toHaveBeenCalledWith('room_ban.created', {
        hostId: 'host-1',
        bannedUserId: 'troll-1',
        streamId: 's1',
        scope: RoomBanScope.SESSION,
        actorId: 'host-1',
      });
    });

    it('names the moderator who issued the ban, for the audit trail', async () => {
      await service().ban('host-1', 'troll-1', RoomBanScope.SESSION, 's1', 'mod-1');

      expect(events.emit).toHaveBeenCalledWith('room_ban.created', expect.objectContaining({ actorId: 'mod-1' }));
    });

    it('never persists or emits a streamId for a permanent ban, even if one was given', async () => {
      await service().ban('host-1', 'troll-1', RoomBanScope.HOST_PERMANENT, 's1');

      expect(prisma.roomBan.create).toHaveBeenCalledWith({
        data: { hostId: 'host-1', bannedUserId: 'troll-1', scope: RoomBanScope.HOST_PERMANENT, streamId: null },
      });
      expect(events.emit).toHaveBeenCalledWith('room_ban.created', {
        hostId: 'host-1',
        bannedUserId: 'troll-1',
        streamId: null,
        scope: RoomBanScope.HOST_PERMANENT,
        actorId: 'host-1',
      });
    });
  });

  describe('unban', () => {
    it('announces a lifted ban with who lifted it', async () => {
      await service().unban('host-1', 'troll-1', 's1', 'mod-1');

      expect(events.emit).toHaveBeenCalledWith('room_ban.lifted', {
        hostId: 'host-1',
        bannedUserId: 'troll-1',
        streamId: 's1',
        actorId: 'mod-1',
      });
    });

    it('stays quiet when there was no ban to lift', async () => {
      prisma.roomBan.deleteMany.mockResolvedValue({ count: 0 });

      await service().unban('host-1', 'troll-1', 's1');

      expect(events.emit).not.toHaveBeenCalled();
    });

    it('lifts a permanent ban and a specific-stream ban together', async () => {
      await service().unban('host-1', 'troll-1', 's1');

      expect(prisma.roomBan.deleteMany).toHaveBeenCalledWith({
        where: {
          hostId: 'host-1',
          bannedUserId: 'troll-1',
          OR: [{ scope: RoomBanScope.HOST_PERMANENT }, { streamId: 's1' }],
        },
      });
    });

    it('only targets the permanent ban when no streamId is given', async () => {
      await service().unban('host-1', 'troll-1');

      expect(prisma.roomBan.deleteMany).toHaveBeenCalledWith({
        where: {
          hostId: 'host-1',
          bannedUserId: 'troll-1',
          OR: [{ scope: RoomBanScope.HOST_PERMANENT }],
        },
      });
    });
  });

  describe('isBanned', () => {
    it('is true when a matching ban row exists', async () => {
      prisma.roomBan.findFirst.mockResolvedValue({ id: 'b1' });

      await expect(service().isBanned('host-1', 'troll-1', 's1')).resolves.toBe(true);
      expect(prisma.roomBan.findFirst).toHaveBeenCalledWith({
        where: {
          hostId: 'host-1',
          bannedUserId: 'troll-1',
          OR: [{ scope: RoomBanScope.HOST_PERMANENT }, { streamId: 's1' }],
        },
        select: { id: true },
      });
    });

    it('is false when there is no matching ban', async () => {
      prisma.roomBan.findFirst.mockResolvedValue(null);

      await expect(service().isBanned('host-1', 'troll-1', 's1')).resolves.toBe(false);
    });
  });
});
