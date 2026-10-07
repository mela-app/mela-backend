import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ChatModerationStatus } from '@prisma/client';
import { ChatService } from '../../chat/chat.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminPrincipal } from '../admin.guard';
import { AdminChatService } from './admin-chat.service';

const person = (id: string, name: string) => ({
  id,
  username: name.toLowerCase(),
  displayName: name,
  avatarUrl: null,
});
const ana = person('ana-1', 'Ana');
const ben = person('ben-1', 'Ben');

const DAY = { from: '2026-10-04T00:00:00.000Z', to: '2026-10-04T23:59:59.999Z' };
const RANGE = { gte: new Date(DAY.from), lte: new Date(DAY.to) };
const at = (hour: number) => new Date(`2026-10-04T${String(hour).padStart(2, '0')}:00:00.000Z`);
const RUNNING_THAT_DAY = {
  startedAt: { lte: RANGE.lte },
  OR: [{ endedAt: null }, { endedAt: { gte: RANGE.gte } }],
};

describe('AdminChatService', () => {
  const prisma = {
    stream: { findMany: jest.fn() },
    chatMessage: { groupBy: jest.fn(), findMany: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  const chat = { eraseAsAdmin: jest.fn() };
  const service = () =>
    new AdminChatService(prisma as unknown as PrismaService, chat as unknown as ChatService);

  beforeEach(() => jest.clearAllMocks());

  describe('deleteMessages', () => {
    it('erases the picked messages for good, each once, as the signed-in admin', async () => {
      chat.eraseAsAdmin.mockResolvedValue(2);
      const admin = { id: 'admin-1' } as AdminPrincipal;

      await expect(service().deleteMessages(admin, ['m1', 'm2', 'm1'])).resolves.toEqual({
        deleted: 2,
      });
      expect(chat.eraseAsAdmin).toHaveBeenCalledWith(['m1', 'm2'], 'admin-1');
    });
  });

  describe('hosts', () => {
    it('lists the hosts whose lives had chat that day, the latest message first', async () => {
      prisma.stream.findMany.mockResolvedValue([
        { id: 's1', host: ana },
        { id: 's2', host: ana },
        { id: 's3', host: ben },
        { id: 's4', host: ben },
      ]);
      prisma.chatMessage.groupBy.mockResolvedValue([
        {
          streamId: 's1',
          _count: { _all: 4 },
          _min: { createdAt: at(8) },
          _max: { createdAt: at(9) },
        },
        {
          streamId: 's2',
          _count: { _all: 6 },
          _min: { createdAt: at(18) },
          _max: { createdAt: at(20) },
        },
        {
          streamId: 's3',
          _count: { _all: 2 },
          _min: { createdAt: at(10) },
          _max: { createdAt: at(21) },
        },
      ]);

      const page = await service().hosts({ ...DAY, page: 1, pageSize: 25 });

      expect(page).toEqual({
        items: [
          {
            host: ben,
            liveCount: 1,
            messageCount: 2,
            firstMessageAt: at(10),
            lastMessageAt: at(21),
          },
          {
            host: ana,
            liveCount: 2,
            messageCount: 10,
            firstMessageAt: at(8),
            lastMessageAt: at(20),
          },
        ],
        total: 2,
        page: 1,
        pageSize: 25,
        messageCount: 12,
      });
      expect(prisma.stream.findMany.mock.calls[0][0].where).toEqual(RUNNING_THAT_DAY);
      expect(prisma.chatMessage.groupBy.mock.calls[0][0].where).toEqual({
        streamId: { in: ['s1', 's2', 's3', 's4'] },
        createdAt: RANGE,
      });
    });

    it('searches hosts by name and pages through them', async () => {
      prisma.stream.findMany.mockResolvedValue([
        { id: 's1', host: ana },
        { id: 's3', host: ben },
      ]);
      prisma.chatMessage.groupBy.mockResolvedValue([
        {
          streamId: 's1',
          _count: { _all: 1 },
          _min: { createdAt: at(8) },
          _max: { createdAt: at(8) },
        },
        {
          streamId: 's3',
          _count: { _all: 1 },
          _min: { createdAt: at(9) },
          _max: { createdAt: at(9) },
        },
      ]);

      const page = await service().hosts({ ...DAY, q: ' an ', page: 2, pageSize: 1 });

      expect(page.items.map((row) => row.host)).toEqual([ana]);
      expect(page.total).toBe(2);
      expect(prisma.stream.findMany.mock.calls[0][0].where).toEqual({
        ...RUNNING_THAT_DAY,
        host: {
          OR: [
            { username: { contains: 'an', mode: 'insensitive' } },
            { displayName: { contains: 'an', mode: 'insensitive' } },
          ],
        },
      });
    });

    it('a day without lives looks no further', async () => {
      prisma.stream.findMany.mockResolvedValue([]);

      const page = await service().hosts({ ...DAY, page: 1, pageSize: 25 });

      expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 25, messageCount: 0 });
      expect(prisma.chatMessage.groupBy).not.toHaveBeenCalled();
    });

    it('refuses a range that ends before it starts', async () => {
      await expect(
        service().hosts({ from: DAY.to, to: DAY.from, page: 1, pageSize: 25 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.stream.findMany).not.toHaveBeenCalled();
    });
  });

  describe('hostChat', () => {
    const live = (id: string, hour: number) => ({
      id,
      title: `Live ${id}`,
      category: null,
      status: 'ENDED',
      startedAt: at(hour),
      endedAt: at(hour + 1),
    });
    const message = (id: string, streamId: string) => ({
      id,
      streamId,
      text: `text ${id}`,
      imageUrl: null,
      moderationStatus: 'VISIBLE',
      flaggedReason: null,
      createdAt: at(9),
      user: ben,
    });

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(ana);
      prisma.stream.findMany.mockResolvedValue([live('s1', 8), live('s2', 12), live('s3', 18)]);
    });

    it("shows the host's chat that day oldest first, with the lives it came from", async () => {
      prisma.chatMessage.findMany.mockResolvedValue([
        message('m1', 's1'),
        message('m2', 's1'),
        message('m3', 's3'),
      ]);
      prisma.chatMessage.groupBy.mockResolvedValue([
        { streamId: 's3', _count: { _all: 1 } },
        { streamId: 's1', _count: { _all: 2 } },
      ]);

      const chat = await service().hostChat('ana-1', { ...DAY, limit: 2 });

      expect(chat).toEqual({
        host: ana,
        lives: [
          { ...live('s1', 8), messageCount: 2 },
          { ...live('s3', 18), messageCount: 1 },
        ],
        messages: [message('m1', 's1'), message('m2', 's1')],
        nextCursor: 'm2',
      });
      expect(prisma.stream.findMany.mock.calls[0][0]).toMatchObject({
        where: { hostId: 'ana-1', ...RUNNING_THAT_DAY },
        orderBy: { startedAt: 'asc' },
      });
      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { streamId: { in: ['s1', 's2', 's3'] }, createdAt: RANGE },
          orderBy: { id: 'asc' },
          take: 3,
        }),
      );
    });

    it('narrows to one moderation status or some text, and continues after a cursor', async () => {
      prisma.chatMessage.findMany.mockResolvedValue([]);
      prisma.chatMessage.groupBy.mockResolvedValue([]);

      const chat = await service().hostChat('ana-1', {
        ...DAY,
        status: ChatModerationStatus.DELETED,
        q: ' spam ',
        cursor: 'm2',
        limit: 100,
      });

      const filter = {
        streamId: { in: ['s1', 's2', 's3'] },
        createdAt: RANGE,
        moderationStatus: 'DELETED',
        text: { contains: 'spam', mode: 'insensitive' },
      };
      expect(prisma.chatMessage.findMany.mock.calls[0][0].where).toEqual({
        ...filter,
        id: { gt: 'm2' },
      });
      expect(prisma.chatMessage.groupBy.mock.calls[0][0].where).toEqual(filter);
      expect(chat.lives).toEqual([]);
      expect(chat.nextCursor).toBeNull();
    });

    it('a host who was not live that day has no chat to read', async () => {
      prisma.stream.findMany.mockResolvedValue([]);

      const chat = await service().hostChat('ana-1', { ...DAY, limit: 100 });

      expect(chat).toEqual({ host: ana, lives: [], messages: [], nextCursor: null });
      expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
    });

    it('an unknown host is a 404', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service().hostChat('nope', { ...DAY, limit: 100 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
