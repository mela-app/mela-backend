import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AdminPermission,
  AlertScope,
  AlertSeverity,
  BannedPhraseSeverity,
  PlatformRole,
  Prisma,
  StreamStatus,
} from '@prisma/client';
import { BannedPhrasesService } from '../../chat/banned-phrases.service';
import { effectiveAdminPermissions } from '../../common/permissions/admin-permissions';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { AdminPrincipal } from '../admin.guard';
import { AdminContentService } from './admin-content.service';

const LIVE = '3f1c9a52-7c2e-4a8b-9d7e-2b6f0c1d4e5a';

describe('AdminContentService', () => {
  const prisma = {
    stream: { findUnique: jest.fn(), findMany: jest.fn() },
    adminAlert: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    bannedPhrase: { create: jest.fn(), update: jest.fn(), delete: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
  };
  const realtime = { connectedCount: jest.fn() };
  const events = { emit: jest.fn() };

  const service = () =>
    new AdminContentService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeGateway,
      new BannedPhrasesService(prisma as unknown as PrismaService),
      events as unknown as EventEmitter2,
    );

  function principal(platformRole: PlatformRole, granted: AdminPermission[] = []): AdminPrincipal {
    return {
      id: 'admin-1',
      username: 'admin',
      email: 'admin@example.com',
      displayName: 'Admin',
      avatarUrl: null,
      platformRole,
      permissions: effectiveAdminPermissions(platformRole, granted),
      passwordChangeRequired: false,
      sessionId: 'session-1',
    };
  }
  const superAdmin = principal(PlatformRole.SUPER_ADMIN);
  const moderator = principal(PlatformRole.PLATFORM_MODERATOR, [AdminPermission.SEND_ALERTS]);

  beforeEach(() => {
    jest.clearAllMocks();
    realtime.connectedCount.mockReturnValue(42);
    prisma.adminAlert.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'alert-1', createdAt: new Date('2026-09-27T10:00:00Z'), ...data }),
    );
  });

  describe('alerts', () => {
    it('offers the running lives with how many devices each alert would reach', async () => {
      prisma.stream.findMany.mockResolvedValue([{ id: LIVE, title: 'Poker night', host: { id: 'h1', username: 'host' } }]);

      await expect(service().alertTargets()).resolves.toEqual({
        items: [{ id: LIVE, title: 'Poker night', host: { id: 'h1', username: 'host' }, reach: 42 }],
      });
      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: StreamStatus.LIVE } }),
      );
      expect(realtime.connectedCount).toHaveBeenCalledWith(LIVE);
    });

    it('lets only those given it alert everyone', async () => {
      const error = await service()
        .sendAlert(moderator, { scope: AlertScope.GLOBAL, message: 'Maintenance', severity: AlertSeverity.INFO })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toEqual(
        expect.objectContaining({ code: 'MISSING_PERMISSION' }),
      );
      expect(prisma.adminAlert.create).not.toHaveBeenCalled();

      const trusted = principal(PlatformRole.PLATFORM_MODERATOR, [AdminPermission.SEND_GLOBAL_ALERTS]);
      await service().sendAlert(trusted, { scope: AlertScope.GLOBAL, message: 'Maintenance', severity: AlertSeverity.INFO });
      expect(prisma.adminAlert.create).toHaveBeenCalledTimes(1);
    });

    it('lets a platform moderator alert one running live, and records who it reached', async () => {
      prisma.stream.findUnique.mockResolvedValue({ status: StreamStatus.LIVE });

      await service().sendAlert(moderator, {
        scope: AlertScope.STREAM,
        streamId: LIVE,
        message: 'Keep it civil',
        severity: AlertSeverity.WARNING,
      });

      expect(realtime.connectedCount).toHaveBeenCalledWith(LIVE);
      expect(prisma.adminAlert.create).toHaveBeenCalledWith({
        data: {
          scope: AlertScope.STREAM,
          streamId: LIVE,
          message: 'Keep it civil',
          severity: AlertSeverity.WARNING,
          createdById: 'admin-1',
          recipientCount: 42,
        },
      });
      expect(events.emit).toHaveBeenCalledWith('admin_alert.sent', {
        alertId: 'alert-1',
        actorId: 'admin-1',
        scope: AlertScope.STREAM,
        streamId: LIVE,
        message: 'Keep it civil',
        severity: AlertSeverity.WARNING,
        createdAt: new Date('2026-09-27T10:00:00Z'),
      });
    });

    it('refuses a live that ended or does not exist', async () => {
      prisma.stream.findUnique.mockResolvedValueOnce({ status: StreamStatus.ENDED });
      await expect(
        service().sendAlert(moderator, { scope: AlertScope.STREAM, streamId: LIVE, message: 'Hi', severity: AlertSeverity.INFO }),
      ).rejects.toThrow(ConflictException);

      prisma.stream.findUnique.mockResolvedValueOnce(null);
      await expect(
        service().sendAlert(moderator, { scope: AlertScope.STREAM, streamId: LIVE, message: 'Hi', severity: AlertSeverity.INFO }),
      ).rejects.toThrow(NotFoundException);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('sends a global alert to every connected app, ignoring any stream id', async () => {
      await service().sendAlert(superAdmin, {
        scope: AlertScope.GLOBAL,
        streamId: LIVE,
        message: 'Scheduled maintenance at 02:00 UTC',
        severity: AlertSeverity.CRITICAL,
      });

      expect(realtime.connectedCount).toHaveBeenCalledWith(undefined);
      expect(prisma.adminAlert.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ scope: AlertScope.GLOBAL, streamId: null }),
      });
    });
  });

  describe('banned phrases', () => {
    it('adds a phrase and tells the chat filter', async () => {
      prisma.bannedPhrase.create.mockResolvedValue({ id: 'p1', phrase: 'scam link', severity: BannedPhraseSeverity.REJECT });

      await service().addPhrase(superAdmin, { phrase: 'scam link', severity: BannedPhraseSeverity.REJECT });

      expect(prisma.bannedPhrase.create).toHaveBeenCalledWith({
        data: { phrase: 'scam link', severity: BannedPhraseSeverity.REJECT, createdBy: 'admin-1' },
      });
      expect(events.emit).toHaveBeenCalledWith('banned_phrase.created', {
        phraseId: 'p1',
        actorId: 'admin-1',
        phrase: 'scam link',
        severity: BannedPhraseSeverity.REJECT,
      });
    });

    it('explains a duplicate instead of failing', async () => {
      prisma.bannedPhrase.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
      );

      await expect(
        service().addPhrase(superAdmin, { phrase: 'scam link', severity: BannedPhraseSeverity.MASK }),
      ).rejects.toThrow(new ConflictException('That phrase is already on the list'));
    });

    it('removes a phrase, and 404s one that is gone', async () => {
      prisma.bannedPhrase.findUnique.mockResolvedValueOnce({ id: 'p1', phrase: 'x', severity: BannedPhraseSeverity.MASK });
      await expect(service().removePhrase(superAdmin, 'p1')).resolves.toEqual({ ok: true });
      expect(events.emit).toHaveBeenCalledWith('banned_phrase.deleted', expect.objectContaining({ phraseId: 'p1' }));

      prisma.bannedPhrase.findUnique.mockResolvedValueOnce(null);
      await expect(service().removePhrase(superAdmin, 'p2')).rejects.toThrow(NotFoundException);
    });

    it('shows what the live filter would do with a message', async () => {
      prisma.bannedPhrase.findMany.mockResolvedValue([
        { phrase: 'scam', severity: BannedPhraseSeverity.REJECT },
        { phrase: 'darn', severity: BannedPhraseSeverity.MASK },
      ]);
      const content = service();

      await expect(content.testPhrase('what a d a r n shame')).resolves.toEqual({
        matches: [{ phrase: 'darn', severity: BannedPhraseSeverity.MASK }],
        outcome: 'MASKED',
        delivered: expect.not.stringContaining('d a r n'),
      });
      await expect(content.testPhrase('free S C A M here')).resolves.toEqual(
        expect.objectContaining({ outcome: 'REJECTED', delivered: null }),
      );
      await expect(content.testPhrase('hello everyone')).resolves.toEqual({
        matches: [],
        outcome: 'ALLOWED',
        delivered: 'hello everyone',
      });
    });
  });
});
