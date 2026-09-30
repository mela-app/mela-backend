import { AuditActorRole, AuditCategory, PlatformRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RequestContext } from '../common/request-context/request-context';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    auditLog: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  };
  const service = () => new AuditService(prisma as unknown as PrismaService);
  const written = () => prisma.auditLog.create.mock.calls[0][0].data;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.auditLog.create.mockResolvedValue({});
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
  });

  describe('record', () => {
    it('files the entry under its category, with who, from where', async () => {
      prisma.user.findUnique.mockResolvedValue({ username: 'admin', platformRole: PlatformRole.SUPER_ADMIN });

      await RequestContext.run({ ip: '203.0.113.9', userAgent: 'Firefox', surface: 'admin' }, () =>
        service().record({
          action: 'user.suspended',
          actorId: 'admin-1',
          target: { type: 'USER', id: 'u1', label: '@troll' },
          reason: 'Spam',
        }),
      );

      expect(written()).toEqual(
        expect.objectContaining({
          category: AuditCategory.ADMIN,
          action: 'user.suspended',
          actorId: 'admin-1',
          actorRole: AuditActorRole.SUPER_ADMIN,
          actorLabel: '@admin',
          targetType: 'USER',
          targetId: 'u1',
          targetLabel: '@troll',
          reason: 'Spam',
          ip: '203.0.113.9',
          userAgent: 'Firefox',
        }),
      );
    });

    it('tells the host of a live apart from their moderators', async () => {
      prisma.user.findUnique.mockResolvedValue({ username: 'ana', platformRole: PlatformRole.USER });

      await service().record({ action: 'moderation.chat_muted', actorId: 'host-1', hostId: 'host-1' });
      await service().record({ action: 'moderation.chat_muted', actorId: 'mod-1', hostId: 'host-1' });

      expect(prisma.auditLog.create.mock.calls[0][0].data.actorRole).toBe(AuditActorRole.HOST);
      expect(prisma.auditLog.create.mock.calls[1][0].data.actorRole).toBe(AuditActorRole.MODERATOR);
    });

    it("doesn't credit an app action to staff powers just because the actor is staff", async () => {
      prisma.user.findUnique.mockResolvedValue({ username: 'admin', platformRole: PlatformRole.SUPER_ADMIN });

      await RequestContext.run({ surface: 'app' }, () =>
        service().record({ action: 'social.followed', actorId: 'admin-1' }),
      );

      expect(written().actorRole).toBe(AuditActorRole.USER);
    });

    it('attributes an entry with no actor, or a deleted one, to the system', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service().record({ action: 'stream.ended', actorId: 'deleted-user' });

      expect(written()).toEqual(expect.objectContaining({ actorId: null, actorRole: AuditActorRole.SYSTEM }));
    });

    it('keeps long free text within bounds', async () => {
      await service().record({ action: 'user.suspended', reason: 'x'.repeat(2_000) });

      expect(written().reason).toHaveLength(500);
      expect(written().reason.endsWith('…')).toBe(true);
    });

    it('never fails the action it describes', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('db down'));

      await expect(service().record({ action: 'auth.signed_in', actorId: null })).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    const whereOf = () => prisma.auditLog.findMany.mock.calls[0][0].where;

    it('combines every filter, and finds a user as actor or target', async () => {
      await service().list({
        page: 2,
        pageSize: 50,
        category: AuditCategory.MODERATION,
        userId: 'u1',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T23:59:59.999Z',
      });

      expect(whereOf()).toEqual({
        AND: [
          { category: AuditCategory.MODERATION },
          { OR: [{ actorId: 'u1' }, { targetType: 'USER', targetId: 'u1' }] },
          {
            createdAt: {
              gte: new Date('2026-09-01T00:00:00.000Z'),
              lte: new Date('2026-09-30T23:59:59.999Z'),
            },
          },
        ],
      });
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 50 }));
    });

    it('searches the words people see, not just the stored codes', async () => {
      await service().list({ page: 1, pageSize: 25, q: 'suspended' });

      const or = whereOf().AND[0].OR;
      expect(or).toEqual(
        expect.arrayContaining([
          { actorLabel: { contains: 'suspended', mode: 'insensitive' } },
          { action: { in: expect.arrayContaining(['user.suspended']) } },
        ]),
      );
    });

    it('labels each entry for display', async () => {
      prisma.auditLog.findMany.mockResolvedValue([{ id: 'a1', action: 'stream.locked', category: AuditCategory.STREAM }]);

      const page = await service().list({ page: 1, pageSize: 25 });

      expect(page.items[0]).toEqual(
        expect.objectContaining({ actionLabel: 'Locked a live', categoryLabel: 'Lives' }),
      );
    });
  });

  it('exports CSV that a spreadsheet cannot mistake for formulas', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1',
        createdAt: new Date('2026-09-27T10:00:00.000Z'),
        category: AuditCategory.CHAT,
        action: 'chat.message_deleted',
        actorRole: AuditActorRole.MODERATOR,
        actorLabel: '@mod',
        actorId: 'mod-1',
        targetType: 'MESSAGE',
        targetLabel: '=HYPERLINK("http://evil")',
        targetId: 'm1',
        streamId: 's1',
        reason: 'He said "hi"',
        ip: null,
        userAgent: null,
        metadata: null,
      },
    ]);

    const csv = await service().exportCsv({ page: 1, pageSize: 25 });
    const [header, row] = csv.split('\r\n');

    expect(header.startsWith('"Time (UTC)","Category","Action"')).toBe(true);
    expect(row).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(row).toContain('"He said ""hi"""');
    expect(row).toContain('"Deleted a chat message"');
  });
});
