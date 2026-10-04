import { PrismaService } from '../common/prisma/prisma.service';
import { RoomChatMutesService } from './room-chat-mutes.service';

describe('RoomChatMutesService', () => {
  const prisma = {
    roomChatMute: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const events = { emit: jest.fn() };

  const service = () =>
    new RoomChatMutesService(prisma as unknown as PrismaService, events as never);

  beforeEach(() => jest.clearAllMocks());

  describe('mute', () => {
    it('upserts on (stream, user) so muting again replaces the expiry, and tells the muted user', async () => {
      const until = new Date('2026-09-27T12:00:00Z');

      await service().mute('s1', 'troll-1', 'mod-1', until);

      expect(prisma.roomChatMute.upsert).toHaveBeenCalledWith({
        where: { streamId_userId: { streamId: 's1', userId: 'troll-1' } },
        create: { streamId: 's1', userId: 'troll-1', mutedById: 'mod-1', expiresAt: until },
        update: expect.objectContaining({ mutedById: 'mod-1', expiresAt: until }),
      });
      expect(events.emit).toHaveBeenCalledWith('room_chat_mute.changed', {
        streamId: 's1',
        userId: 'troll-1',
        actorId: 'mod-1',
        muted: true,
        mutedUntil: until,
      });
    });

    it('stores a null expiry for "until the live ends"', async () => {
      await service().mute('s1', 'troll-1', 'host-1', null);

      expect(prisma.roomChatMute.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ expiresAt: null }) }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'room_chat_mute.changed',
        expect.objectContaining({ mutedUntil: null }),
      );
    });
  });

  describe('unmute', () => {
    it('deletes the row and announces the lift', async () => {
      prisma.roomChatMute.deleteMany.mockResolvedValue({ count: 1 });

      await service().unmute('s1', 'troll-1', 'host-1');

      expect(prisma.roomChatMute.deleteMany).toHaveBeenCalledWith({
        where: { streamId: 's1', userId: 'troll-1' },
      });
      expect(events.emit).toHaveBeenCalledWith('room_chat_mute.changed', {
        streamId: 's1',
        userId: 'troll-1',
        actorId: 'host-1',
        muted: false,
        mutedUntil: null,
      });
    });

    it('stays quiet when there was no mute to lift', async () => {
      prisma.roomChatMute.deleteMany.mockResolvedValue({ count: 0 });

      await service().unmute('s1', 'someone', 'host-1');

      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('findActive', () => {
    it('only matches a mute with no expiry or one still in the future', async () => {
      prisma.roomChatMute.findFirst.mockResolvedValue({ expiresAt: null });

      await expect(service().findActive('s1', 'troll-1')).resolves.toEqual({ expiresAt: null });

      const where = prisma.roomChatMute.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ streamId: 's1', userId: 'troll-1' });
      expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
    });
  });

  describe('listActive', () => {
    it('flattens each running mute into the muted profile plus mutedUntil', async () => {
      const until = new Date('2026-09-27T12:00:00Z');
      prisma.roomChatMute.findMany.mockResolvedValue([
        {
          expiresAt: until,
          user: { id: 'troll-1', username: 'troll', displayName: 'Troll', avatarUrl: null },
        },
      ]);

      await expect(service().listActive('s1')).resolves.toEqual({
        items: [
          {
            id: 'troll-1',
            username: 'troll',
            displayName: 'Troll',
            avatarUrl: null,
            mutedUntil: until,
          },
        ],
      });
      expect(prisma.roomChatMute.findMany.mock.calls[0][0].where.OR).toHaveLength(2);
    });
  });
});
