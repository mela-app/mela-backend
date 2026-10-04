import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ModeratorCapability, ModeratorStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ModeratorsService } from './moderators.service';

const STREAM = 's1';

describe('ModeratorsService', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    moderator: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const events = { emit: jest.fn() };

  const service = () => new ModeratorsService(prisma as unknown as PrismaService, events as never);

  beforeEach(() => jest.clearAllMocks());

  describe('who moderates a stream', () => {
    it('lists the active moderators, first appointed first', async () => {
      prisma.moderator.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);

      await expect(service().listActiveUserIds(STREAM)).resolves.toEqual(['u1', 'u2']);
      expect(prisma.moderator.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { streamId: STREAM, status: ModeratorStatus.ACTIVE } }),
      );
    });

    it('counts only an active grant as being a moderator', async () => {
      prisma.moderator.findUnique.mockResolvedValueOnce({
        capabilities: [],
        status: ModeratorStatus.ACTIVE,
      });
      await expect(service().isActiveModerator(STREAM, 'u1')).resolves.toBe(true);

      prisma.moderator.findUnique.mockResolvedValueOnce({
        capabilities: [],
        status: ModeratorStatus.REVOKED,
      });
      await expect(service().isActiveModerator(STREAM, 'u1')).resolves.toBe(false);
    });
  });

  describe('findActiveGrant', () => {
    it('is null when there is no grant at all', async () => {
      prisma.moderator.findUnique.mockResolvedValue(null);

      await expect(service().findActiveGrant(STREAM, 'u1')).resolves.toBeNull();
      expect(prisma.moderator.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { streamId_userId: { streamId: STREAM, userId: 'u1' } } }),
      );
    });

    it('is null once a grant has been revoked', async () => {
      prisma.moderator.findUnique.mockResolvedValue({
        capabilities: [ModeratorCapability.DELETE_MESSAGES],
        status: ModeratorStatus.REVOKED,
      });

      await expect(service().findActiveGrant(STREAM, 'u1')).resolves.toBeNull();
    });

    it('returns the capabilities of an active grant', async () => {
      prisma.moderator.findUnique.mockResolvedValue({
        capabilities: [ModeratorCapability.PIN_MESSAGES],
        status: ModeratorStatus.ACTIVE,
      });

      await expect(service().findActiveGrant(STREAM, 'u1')).resolves.toEqual({
        capabilities: [ModeratorCapability.PIN_MESSAGES],
      });
    });

    it('does not carry over to a different stream', async () => {
      prisma.moderator.findUnique.mockResolvedValue(null);

      await expect(service().findActiveGrant('a-different-stream', 'u1')).resolves.toBeNull();
      expect(prisma.moderator.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { streamId_userId: { streamId: 'a-different-stream', userId: 'u1' } },
        }),
      );
    });
  });

  describe('list', () => {
    it('lists only active moderators for this one stream, newest grant first', async () => {
      prisma.moderator.findMany.mockResolvedValue([
        {
          capabilities: [ModeratorCapability.BAN_USERS],
          grantedAt: new Date('2026-01-01'),
          user: { id: 'u1', username: 'a', displayName: 'A', avatarUrl: null },
        },
      ]);

      const result = await service().list(STREAM);

      expect(prisma.moderator.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { streamId: STREAM, status: ModeratorStatus.ACTIVE } }),
      );
      expect(result).toEqual({
        items: [
          {
            user: { id: 'u1', username: 'a', displayName: 'A', avatarUrl: null },
            capabilities: [ModeratorCapability.BAN_USERS],
            grantedAt: new Date('2026-01-01'),
          },
        ],
      });
    });
  });

  describe('grant', () => {
    it('refuses to let a host moderate their own stream', async () => {
      await expect(
        service().grant('host-1', STREAM, 'host-1', [ModeratorCapability.DELETE_MESSAGES]),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.moderator.upsert).not.toHaveBeenCalled();
    });

    it('404s when the target user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service().grant('host-1', STREAM, 'ghost', [ModeratorCapability.DELETE_MESSAGES]),
      ).rejects.toThrow(NotFoundException);
    });

    it('upserts (idempotent), scoped to this stream, and emits moderator.granted', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });

      await expect(
        service().grant('host-1', STREAM, 'u1', [ModeratorCapability.DELETE_MESSAGES]),
      ).resolves.toEqual({ ok: true });

      expect(prisma.moderator.upsert).toHaveBeenCalledWith({
        where: { streamId_userId: { streamId: STREAM, userId: 'u1' } },
        create: {
          hostId: 'host-1',
          streamId: STREAM,
          userId: 'u1',
          capabilities: [ModeratorCapability.DELETE_MESSAGES],
        },
        update: {
          capabilities: [ModeratorCapability.DELETE_MESSAGES],
          status: ModeratorStatus.ACTIVE,
          revokedAt: null,
        },
      });
      expect(events.emit).toHaveBeenCalledWith('moderator.granted', {
        hostId: 'host-1',
        streamId: STREAM,
        userId: 'u1',
        capabilities: [ModeratorCapability.DELETE_MESSAGES],
      });
    });
  });

  describe('updateCapabilities', () => {
    it('404s when the user is not an active moderator for this stream', async () => {
      prisma.moderator.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service().updateCapabilities(STREAM, 'u1', [ModeratorCapability.PIN_MESSAGES]),
      ).rejects.toThrow(NotFoundException);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('updates and emits moderator.updated', async () => {
      prisma.moderator.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service().updateCapabilities(STREAM, 'u1', [ModeratorCapability.PIN_MESSAGES]),
      ).resolves.toEqual({ ok: true });

      expect(prisma.moderator.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { streamId: STREAM, userId: 'u1', status: ModeratorStatus.ACTIVE },
        }),
      );
      expect(events.emit).toHaveBeenCalledWith('moderator.updated', {
        streamId: STREAM,
        userId: 'u1',
        capabilities: [ModeratorCapability.PIN_MESSAGES],
      });
    });
  });

  describe('revoke', () => {
    it('is idempotent and silent when nobody was revoked', async () => {
      prisma.moderator.updateMany.mockResolvedValue({ count: 0 });

      await expect(service().revoke(STREAM, 'u1')).resolves.toEqual({ ok: true });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('emits moderator.revoked when an active grant was actually revoked', async () => {
      prisma.moderator.updateMany.mockResolvedValue({ count: 1 });

      await expect(service().revoke(STREAM, 'u1')).resolves.toEqual({ ok: true });

      expect(events.emit).toHaveBeenCalledWith('moderator.revoked', {
        streamId: STREAM,
        userId: 'u1',
      });
    });
  });
});
