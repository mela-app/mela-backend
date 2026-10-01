import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PlatformRole } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminPrincipal } from '../admin.guard';
import { AdminMessagesService } from './admin-messages.service';

const person = (id: string, name: string) => ({
  id,
  username: name.toLowerCase(),
  displayName: name,
  avatarUrl: null,
});
const ana = person('ana-1', 'Ana');
const ben = person('ben-1', 'Ben');
const cal = person('cal-1', 'Cal');

const DAY = { from: '2026-09-30T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' };
const admin = { id: 'admin-1', platformRole: PlatformRole.SUPER_ADMIN } as AdminPrincipal;

describe('AdminMessagesService', () => {
  const prisma = {
    directMessage: { groupBy: jest.fn(), count: jest.fn(), findMany: jest.fn() },
    conversation: { findMany: jest.fn(), findUnique: jest.fn() },
  };
  const audit = { record: jest.fn() };
  const service = () =>
    new AdminMessagesService(prisma as unknown as PrismaService, audit as unknown as AuditService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.directMessage.count.mockResolvedValue(5);
    prisma.conversation.findUnique.mockResolvedValue({ id: 'c1', userA: ana, userB: ben });
  });

  describe('conversations', () => {
    it('lists who wrote to whom in the range, the latest activity first - without the text', async () => {
      const at = (hour: number) =>
        new Date(`2026-09-30T${String(hour).padStart(2, '0')}:00:00.000Z`);
      prisma.directMessage.groupBy
        .mockResolvedValueOnce([
          {
            conversationId: 'c2',
            _count: { _all: 2 },
            _min: { createdAt: at(9) },
            _max: { createdAt: at(11) },
          },
          {
            conversationId: 'c1',
            _count: { _all: 3 },
            _min: { createdAt: at(8) },
            _max: { createdAt: at(10) },
          },
        ])
        .mockResolvedValueOnce([{ conversationId: 'c1' }, { conversationId: 'c2' }]);
      prisma.conversation.findMany.mockResolvedValue([
        { id: 'c1', userA: ana, userB: ben },
        { id: 'c2', userA: ana, userB: cal },
      ]);

      const page = await service().conversations({ ...DAY, page: 1, pageSize: 25 });

      expect(page).toEqual({
        items: [
          {
            id: 'c2',
            people: [ana, cal],
            messageCount: 2,
            firstMessageAt: at(9),
            lastMessageAt: at(11),
          },
          {
            id: 'c1',
            people: [ana, ben],
            messageCount: 3,
            firstMessageAt: at(8),
            lastMessageAt: at(10),
          },
        ],
        total: 2,
        page: 1,
        pageSize: 25,
        messageCount: 5,
      });
      const [paged] = prisma.directMessage.groupBy.mock.calls[0] as [Record<string, unknown>];
      expect(paged).toMatchObject({
        where: { AND: [{ createdAt: { gte: new Date(DAY.from), lte: new Date(DAY.to) } }] },
        orderBy: { _max: { createdAt: 'desc' } },
        skip: 0,
        take: 25,
      });
      // Only who, never what.
      expect(prisma.conversation.findMany.mock.calls[0][0].select).not.toHaveProperty('messages');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('narrows to one person - picked from their account, or searched by name', async () => {
      prisma.directMessage.groupBy.mockResolvedValue([]);
      prisma.conversation.findMany.mockResolvedValue([]);

      await service().conversations({ ...DAY, userId: 'ana-1', q: ' be ', page: 2, pageSize: 10 });

      const [paged] = prisma.directMessage.groupBy.mock.calls[0] as [
        { where: { AND: unknown[] }; skip: number },
      ];
      const name = {
        OR: [
          { username: { contains: 'be', mode: 'insensitive' } },
          { displayName: { contains: 'be', mode: 'insensitive' } },
        ],
      };
      expect(paged.where.AND).toEqual([
        { createdAt: { gte: new Date(DAY.from), lte: new Date(DAY.to) } },
        { OR: [{ senderId: 'ana-1' }, { recipientId: 'ana-1' }] },
        { OR: [{ sender: name }, { recipient: name }] },
      ]);
      expect(paged.skip).toBe(10);
    });

    it('refuses a range that ends before it starts, or covers more than a month', async () => {
      await expect(
        service().conversations({ from: DAY.to, to: DAY.from, page: 1, pageSize: 25 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service().conversations({
          from: '2026-08-01T00:00:00.000Z',
          to: DAY.to,
          page: 1,
          pageSize: 25,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.directMessage.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('transcript', () => {
    const message = (id: string, senderId: string) => ({
      id,
      senderId,
      text: `text ${id}`,
      createdAt: new Date('2026-09-30T09:00:00.000Z'),
      readAt: null,
    });

    it('shows the messages oldest first, and records the look in the audit trail', async () => {
      prisma.directMessage.findMany.mockResolvedValue([
        message('m1', 'ana-1'),
        message('m2', 'ben-1'),
        message('m3', 'ana-1'),
      ]);

      const transcript = await service().transcript(admin, 'c1', { ...DAY, limit: 2 });

      expect(transcript).toEqual({
        id: 'c1',
        people: [ana, ben],
        messages: [message('m1', 'ana-1'), message('m2', 'ben-1')],
        nextCursor: 'm2',
      });
      expect(prisma.directMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            conversationId: 'c1',
            createdAt: { gte: new Date(DAY.from), lte: new Date(DAY.to) },
          },
          orderBy: { id: 'asc' },
          take: 3,
        }),
      );
      expect(audit.record).toHaveBeenCalledWith({
        action: 'admin.private_messages_viewed',
        actorId: 'admin-1',
        target: { type: 'CONVERSATION', id: 'c1', label: '@ana and @ben' },
        metadata: { from: DAY.from, to: DAY.to, userIds: ['ana-1', 'ben-1'] },
      });
    });

    it('the next page continues the same look - not recorded again', async () => {
      prisma.directMessage.findMany.mockResolvedValue([message('m3', 'ana-1')]);

      const transcript = await service().transcript(admin, 'c1', {
        ...DAY,
        cursor: 'm2',
        limit: 2,
      });

      expect(transcript.nextCursor).toBeNull();
      expect(prisma.directMessage.findMany.mock.calls[0][0].where).toMatchObject({
        id: { gt: 'm2' },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('an unknown conversation is a 404, and nothing is recorded', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(
        service().transcript(admin, 'nope', { ...DAY, limit: 100 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
