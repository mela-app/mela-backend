import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HostingAppealState } from '@prisma/client';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageProvider } from '../common/storage/storage-provider.interface';
import { APPEAL_AGAIN_AFTER_MS, appealOpensAt, isAppealImageKey } from './hosting-rules';
import { HostingRestrictionsService } from './hosting-restrictions.service';

const R1 = '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';
const PHOTO = `hosting-appeals/${R1}/5f0c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c.jpg`;

describe('HostingRestrictionsService', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  const prisma = {
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    user: { findUnique: jest.fn() },
    stream: { findUnique: jest.fn() },
    hostingRestriction: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    hostingRestrictionMessage: { create: jest.fn() },
    hostingRestrictionReason: { findUnique: jest.fn(), create: jest.fn() },
  };
  const events = { emit: jest.fn() };
  const storage = {
    createUploadUrl: jest.fn(),
    publicUrl: jest.fn((key: string) => `https://cdn.example.com/${key}`),
    deleteUrls: jest.fn(),
  };
  const service = () =>
    new HostingRestrictionsService(
      prisma as unknown as PrismaService,
      events as unknown as EventEmitter2,
      storage as unknown as StorageProvider,
    );
  const staff = { id: 'staff-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.hostingRestriction.findMany.mockResolvedValue([]);
  });

  describe('who may host', () => {
    it('refuses a host whose hosting is paused, and only them', async () => {
      prisma.hostingRestriction.findFirst.mockResolvedValueOnce({ id: R1 });
      await expect(service().assertCanHost('host-1', now)).rejects.toThrow(ForbiddenException);

      prisma.hostingRestriction.findFirst.mockResolvedValueOnce(null);
      await expect(service().assertCanHost('host-2', now)).resolves.toBeUndefined();
    });

    it('counts only restrictions not lifted and not run out', async () => {
      prisma.hostingRestriction.findFirst.mockResolvedValueOnce(null);
      await service().active('host-1', now);

      expect(prisma.hostingRestriction.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'host-1',
            liftedAt: null,
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          },
        }),
      );
    });
  });

  describe('for the console', () => {
    it('gives one restriction in force per host, the newest, and asks nothing for no hosts', async () => {
      prisma.hostingRestriction.findMany.mockResolvedValueOnce([
        { id: 'new', userId: 'host-1' },
        { id: 'old', userId: 'host-1' },
        { id: 'r2', userId: 'host-2' },
      ]);

      const rows = await service().inForce(['host-1', 'host-2', 'host-3'], now);

      expect(rows.map((row) => row.id)).toEqual(['new', 'r2']);
      expect(prisma.hostingRestriction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: { in: ['host-1', 'host-2', 'host-3'] },
            liftedAt: null,
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          },
        }),
      );
      expect(await service().inForce([], now)).toEqual([]);
      expect(prisma.hostingRestriction.findMany).toHaveBeenCalledTimes(1);
    });

    it("finds restrictions by the host's name or username", async () => {
      await service().list({ q: ' ana ', filter: 'all', page: 1, pageSize: 20 }, now);

      expect(prisma.hostingRestriction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            user: {
              OR: [
                { username: { contains: 'ana', mode: 'insensitive' } },
                { displayName: { contains: 'ana', mode: 'insensitive' } },
              ],
            },
          },
        }),
      );
    });
  });

  describe('restricting', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ id: 'host-1' });
      prisma.stream.findUnique.mockResolvedValue({ id: 's1' });
      prisma.hostingRestriction.create.mockResolvedValue({ id: R1 });
    });

    it('pauses their hosting because of a live, for as long as the team chose', async () => {
      prisma.hostingRestriction.findFirst.mockResolvedValueOnce(null);
      const svc = service();
      jest.spyOn(svc, 'detail').mockResolvedValue({} as never);

      await svc.restrict(
        staff,
        {
          userId: 'host-1',
          streamId: 's1',
          title: 'Abusive language',
          message: 'You insulted viewers in your live.',
          durationHours: 24,
        },
        now,
      );

      const endsAt = new Date(now.getTime() + 24 * 3_600_000);
      expect(prisma.hostingRestriction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'host-1', streamId: 's1', endsAt }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.HostingRestricted, {
        restrictionId: R1,
        userId: 'host-1',
        streamId: 's1',
        actorId: 'staff-1',
        title: 'Abusive language',
        endsAt,
      });
    });

    it('keeps words written now as a reason for next time, when asked', async () => {
      prisma.hostingRestriction.findFirst.mockResolvedValueOnce(null);
      prisma.hostingRestrictionReason.create.mockResolvedValue({ id: 'reason-1', title: 'Spam' });
      const svc = service();
      jest.spyOn(svc, 'detail').mockResolvedValue({} as never);

      await svc.restrict(
        staff,
        { userId: 'host-1', title: 'Spam', message: 'Repeated links.', saveAsReason: true },
        now,
      );

      expect(prisma.hostingRestriction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reasonId: 'reason-1', endsAt: null }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.HostingReasonSaved,
        expect.objectContaining({ reasonId: 'reason-1', change: 'created' }),
      );
    });

    it('refuses a second restriction while one is in force', async () => {
      prisma.hostingRestriction.findFirst.mockResolvedValueOnce({ id: R1 });

      await expect(
        service().restrict(staff, { userId: 'host-1', title: 'Spam', message: 'Links.' }, now),
      ).rejects.toThrow(ConflictException);
      expect(prisma.hostingRestriction.create).not.toHaveBeenCalled();
    });
  });

  describe('appealing', () => {
    const restriction = (appealState: HostingAppealState, keptAt: Date | null = null) => ({
      id: R1,
      streamId: 's1',
      appealState,
      keptAt,
    });

    it('sends the host words and pictures to the team, whose turn it then is', async () => {
      prisma.hostingRestriction.findFirst
        .mockResolvedValueOnce(restriction(HostingAppealState.NONE))
        .mockResolvedValueOnce(null);

      await service().appeal('host-1', { text: ' It was a joke ', imageKeys: [PHOTO] }, now);

      expect(prisma.hostingRestrictionMessage.create).toHaveBeenCalledWith({
        data: {
          restrictionId: R1,
          authorId: 'host-1',
          fromStaff: false,
          text: 'It was a joke',
          imageUrls: [`https://cdn.example.com/${PHOTO}`],
        },
      });
      expect(prisma.hostingRestriction.update).toHaveBeenCalledWith({
        where: { id: R1 },
        data: { appealState: HostingAppealState.WAITING_STAFF },
      });
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.HostingAppealSent, {
        restrictionId: R1,
        userId: 'host-1',
        streamId: 's1',
      });
    });

    it('waits for the team before the host writes again', async () => {
      prisma.hostingRestriction.findFirst.mockResolvedValueOnce(
        restriction(HostingAppealState.WAITING_STAFF),
      );

      await expect(service().appeal('host-1', { text: 'Hello?' }, now)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.hostingRestrictionMessage.create).not.toHaveBeenCalled();
    });

    it('refuses a picture that is not one handed out for this restriction', async () => {
      prisma.hostingRestriction.findFirst.mockResolvedValueOnce(
        restriction(HostingAppealState.NONE),
      );

      await expect(
        service().appeal('host-1', { text: 'See this', imageKeys: ['avatars/someone.jpg'] }, now),
      ).rejects.toThrow('A picture could not be attached');
    });
  });

  describe('the rules', () => {
    it('lets the host write at once, not while the team is on it, and a day after it was kept', () => {
      expect(appealOpensAt({ appealState: 'NONE', keptAt: null }, now)).toEqual(now);
      expect(appealOpensAt({ appealState: 'WAITING_HOST', keptAt: null }, now)).toEqual(now);
      expect(appealOpensAt({ appealState: 'WAITING_STAFF', keptAt: null }, now)).toBeNull();
      expect(appealOpensAt({ appealState: 'KEPT', keptAt: now }, now)).toEqual(
        new Date(now.getTime() + APPEAL_AGAIN_AFTER_MS),
      );
    });

    it('accepts only picture keys under this restriction', () => {
      expect(isAppealImageKey(PHOTO, R1)).toBe(true);
      expect(isAppealImageKey(PHOTO, '0190a1b2-c3d4-7e5f-8a6b-000000000000')).toBe(false);
      expect(isAppealImageKey(`hosting-appeals/${R1}/../avatars/x.jpg`, R1)).toBe(false);
      expect(
        isAppealImageKey(`hosting-appeals/${R1}/5f0c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c.gif`, R1),
      ).toBe(false);
    });
  });

  describe('the team answering', () => {
    beforeEach(() => {
      prisma.hostingRestriction.findUnique.mockResolvedValue({
        id: R1,
        userId: 'host-1',
        streamId: 's1',
        liftedAt: null,
        endsAt: null,
      });
    });

    it('keeps it, so the host may write again a day later', async () => {
      const svc = service();
      jest.spyOn(svc, 'detail').mockResolvedValue({} as never);

      await svc.answer(staff, R1, { decision: 'KEEP', text: 'The video shows it.' }, now);

      expect(prisma.hostingRestriction.update).toHaveBeenCalledWith({
        where: { id: R1 },
        data: { appealState: HostingAppealState.KEPT, keptAt: now },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.HostingAppealAnswered,
        expect.objectContaining({ decision: 'KEEP', reply: 'The video shows it.' }),
      );
    });

    it('lifts it, with a word to the host', async () => {
      const svc = service();
      jest.spyOn(svc, 'detail').mockResolvedValue({} as never);

      await svc.lift(staff, R1, 'Thanks for explaining.', now);

      expect(prisma.hostingRestrictionMessage.create).toHaveBeenCalledWith({
        data: {
          restrictionId: R1,
          authorId: 'staff-1',
          fromStaff: true,
          text: 'Thanks for explaining.',
        },
      });
      expect(prisma.hostingRestriction.update).toHaveBeenCalledWith({
        where: { id: R1 },
        data: { liftedAt: now, liftedById: 'staff-1' },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.HostingRestrictionLifted,
        expect.objectContaining({ userId: 'host-1', reply: 'Thanks for explaining.' }),
      );
    });

    it('does nothing to one already lifted', async () => {
      prisma.hostingRestriction.findUnique.mockResolvedValueOnce({
        id: R1,
        userId: 'host-1',
        streamId: 's1',
        liftedAt: now,
        endsAt: null,
      });

      await expect(service().lift(staff, R1, undefined, now)).rejects.toThrow(ConflictException);
      expect(prisma.hostingRestriction.update).not.toHaveBeenCalled();
    });
  });
});
