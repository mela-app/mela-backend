import { BadRequestException, ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlatformRole, StreamStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { BannedPhrasesService } from '../../chat/banned-phrases.service';
import { DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageProvider } from '../../common/storage/storage-provider.interface';
import { AdminPrincipal } from '../admin.guard';
import { AdminDataService } from './admin-data.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_RUNNING = { status: { not: StreamStatus.LIVE } };

const delegate = () => ({
  count: jest.fn().mockResolvedValue(0),
  findMany: jest.fn().mockResolvedValue([]),
  findUnique: jest.fn(),
  deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
});

describe('AdminDataService', () => {
  const prisma = {
    user: delegate(),
    userSession: delegate(),
    follow: delegate(),
    block: delegate(),
    personalChatMute: delegate(),
    notificationSettings: delegate(),
    stream: delegate(),
    chatMessage: delegate(),
    streamGuest: delegate(),
    guestRequest: delegate(),
    moderator: delegate(),
    roomBan: delegate(),
    roomChatMute: delegate(),
    recordingPermission: delegate(),
    directMessage: delegate(),
    conversation: delegate(),
    notification: delegate(),
    adminAlert: delegate(),
    auditLog: delegate(),
    bannedPhrase: delegate(),
    appRelease: delegate(),
    $transaction: jest.fn(),
  };
  const tx = {
    $queryRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    user: { deleteMany: jest.fn() },
  };
  const bannedPhrases = { invalidate: jest.fn() };
  const events = { emit: jest.fn() };
  const storage = { deleteUrls: jest.fn().mockResolvedValue(undefined) };
  const admin = {
    id: 'admin-1',
    platformRole: PlatformRole.SUPER_ADMIN,
    sessionId: 'session-1',
  } as AdminPrincipal;
  let hash: string;

  const service = () =>
    new AdminDataService(
      prisma as unknown as PrismaService,
      bannedPhrases as unknown as BannedPhrasesService,
      events as unknown as EventEmitter2,
      storage as unknown as StorageProvider,
    );

  beforeAll(async () => {
    hash = await argon2.hash('right password 1');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ passwordHash: hash });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.chatMessage.findMany.mockResolvedValue([]);
    prisma.stream.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation((work: unknown) =>
      Array.isArray(work) ? Promise.all(work) : (work as (client: typeof tx) => unknown)(tx),
    );
  });

  describe('overview', () => {
    it('counts each kind of data, and the lives running right now', async () => {
      prisma.stream.count.mockImplementation((args?: { where?: unknown }) =>
        Promise.resolve(args?.where ? 2 : 40),
      );
      prisma.chatMessage.count.mockResolvedValue(1234);
      prisma.user.count.mockResolvedValue(57);

      const overview = await service().overview();

      expect(overview.runningLives).toBe(2);
      expect(overview.sets.find((set) => set.key === 'chat')).toEqual({
        key: 'chat',
        group: 'lives',
        label: 'Live chat',
        description: expect.any(String),
        tables: ['chat_messages'],
        ageFilter: 'created',
        count: 1234,
      });
      expect(overview.sets.find((set) => set.key === 'lives')?.count).toBe(40);
      expect(overview.sets.find((set) => set.key === 'users')?.count).toBe(57);
      expect(prisma.user.count).toHaveBeenCalledWith({
        where: { platformRole: PlatformRole.USER },
      });
      expect(overview.sets.find((set) => set.key === 'sessions')?.ageFilter).toBe('lastUsed');
    });
  });

  describe('clear', () => {
    it('asks for the password again, and removes nothing without it', async () => {
      const attempt = service().clear(admin, 'follows', undefined, 'wrong password 1');

      await expect(attempt).rejects.toThrow(BadRequestException);
      expect(prisma.follow.deleteMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('removes chat older than some days, keeping running lives, photos included', async () => {
      const photo = 'https://media.example/chat-images/s1/a.jpg';
      prisma.chatMessage.findMany.mockResolvedValue([{ imageUrl: photo }]);
      prisma.chatMessage.deleteMany.mockResolvedValue({ count: 120 });
      const start = Date.now();

      await expect(service().clear(admin, 'chat', 30, 'right password 1')).resolves.toEqual({
        removed: 120,
      });

      const where = prisma.chatMessage.deleteMany.mock.calls[0][0].where;
      expect(where.stream).toEqual(NOT_RUNNING);
      const cutoff = (where.createdAt.lt as Date).getTime();
      expect(cutoff).toBeGreaterThanOrEqual(start - 30 * DAY_MS);
      expect(cutoff).toBeLessThanOrEqual(Date.now() - 30 * DAY_MS);
      expect(storage.deleteUrls).toHaveBeenCalledWith([photo]);
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.DataCleared, {
        actorId: 'admin-1',
        dataSet: 'chat',
        label: 'Live chat',
        olderThanDays: 30,
        removed: 120,
        signedOut: false,
      });
    });

    it('only removes some kinds all at once', async () => {
      await expect(service().clear(admin, 'follows', 30, 'right password 1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.follow.deleteMany).not.toHaveBeenCalled();
    });

    it("signs everyone out but this console, and drops everyone else's connections", async () => {
      prisma.userSession.deleteMany.mockResolvedValue({ count: 9 });

      await service().clear(admin, 'sessions', undefined, 'right password 1');

      expect(prisma.userSession.deleteMany).toHaveBeenCalledWith({
        where: { id: { not: 'session-1' } },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.DataCleared,
        expect.objectContaining({ dataSet: 'sessions', signedOut: true }),
      );
    });

    it('signs out only devices unused for some days, leaving the rest connected', async () => {
      await service().clear(admin, 'sessions', 90, 'right password 1');

      const where = prisma.userSession.deleteMany.mock.calls[0][0].where;
      expect(where.lastSeenAt.lt).toBeInstanceOf(Date);
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.DataCleared,
        expect.objectContaining({ signedOut: false }),
      );
    });

    it('removes app users with their lives first, keeping staff and anyone live, and their files', async () => {
      prisma.chatMessage.findMany.mockResolvedValue([{ imageUrl: 'https://media.example/p.jpg' }]);
      prisma.user.findMany.mockResolvedValue([{ avatarUrl: 'https://media.example/a.jpg' }]);
      prisma.user.deleteMany.mockResolvedValue({ count: 12 });
      const leaving = {
        platformRole: PlatformRole.USER,
        streams: { none: { status: StreamStatus.LIVE } },
      };

      await expect(service().clear(admin, 'users', undefined, 'right password 1')).resolves.toEqual(
        {
          removed: 12,
        },
      );

      expect(prisma.stream.deleteMany).toHaveBeenCalledWith({ where: { host: leaving } });
      expect(prisma.user.deleteMany).toHaveBeenCalledWith({ where: leaving });
      expect(prisma.stream.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.user.deleteMany.mock.invocationCallOrder[0],
      );
      expect(storage.deleteUrls).toHaveBeenCalledWith([
        'https://media.example/p.jpg',
        'https://media.example/a.jpg',
      ]);
    });

    it('removes private messages, then the conversations left empty', async () => {
      prisma.directMessage.deleteMany.mockResolvedValue({ count: 30 });

      await expect(
        service().clear(admin, 'privateMessages', undefined, 'right password 1'),
      ).resolves.toEqual({ removed: 30 });

      expect(prisma.directMessage.deleteMany).toHaveBeenCalledWith({ where: {} });
      expect(prisma.conversation.deleteMany).toHaveBeenCalledWith({
        where: { messages: { none: {} } },
      });
    });

    it('lets the chat filter know its banned phrases are gone', async () => {
      await service().clear(admin, 'bannedPhrases', undefined, 'right password 1');

      expect(prisma.bannedPhrase.deleteMany).toHaveBeenCalled();
      expect(bannedPhrases.invalidate).toHaveBeenCalled();
    });

    it('keeps the bans in running lives, the permanent ones aside', async () => {
      await service().clear(admin, 'roomBans', undefined, 'right password 1');

      expect(prisma.roomBan.deleteMany).toHaveBeenCalledWith({
        where: { OR: [{ streamId: null }, { stream: { is: NOT_RUNNING } }] },
      });
    });
  });

  describe('reset', () => {
    beforeEach(() => {
      tx.$queryRaw.mockResolvedValue(
        [
          '_prisma_migrations',
          'users',
          'user_sessions',
          'user_identities',
          'notification_settings',
          'follows',
          'streams',
          'audit_logs',
          'app_releases',
        ].map((name) => ({ name })),
      );
      tx.user.deleteMany.mockResolvedValue({ count: 25 });
    });

    it("empties every table but the admin's own account, and what they chose to keep", async () => {
      prisma.chatMessage.findMany.mockResolvedValue([{ imageUrl: 'https://media.example/p.jpg' }]);

      await expect(service().reset(admin, 'right password 1', ['auditLog'])).resolves.toEqual({
        usersRemoved: 25,
      });

      expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
        'TRUNCATE "follows", "streams", "app_releases"',
      );
      expect(tx.user.deleteMany).toHaveBeenCalledWith({ where: { id: { not: 'admin-1' } } });
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { AND: [{ id: { not: 'admin-1' } }, { avatarUrl: { not: null } }] },
        select: { avatarUrl: true },
      });
      expect(storage.deleteUrls).toHaveBeenCalledWith(['https://media.example/p.jpg']);
      expect(bannedPhrases.invalidate).toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.DataReset, {
        actorId: 'admin-1',
        kept: ['auditLog'],
        usersRemoved: 25,
      });
    });

    it('waits until no live is running', async () => {
      prisma.stream.count.mockResolvedValue(2);

      await expect(service().reset(admin, 'right password 1', [])).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('asks for the password again first', async () => {
      await expect(service().reset(admin, 'wrong password 1', [])).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
