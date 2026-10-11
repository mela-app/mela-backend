import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StreamVisibility } from '@prisma/client';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { SocialService } from '../social/social.service';
import { LATE_GRACE_MS, REMIND_BEFORE_MS } from './scheduled-live-window';
import { ScheduledLivesService } from './scheduled-lives.service';

describe('ScheduledLivesService', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const inMinutes = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  const prisma = {
    scheduledLive: {
      count: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    scheduledLiveReminder: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    follow: { findMany: jest.fn() },
  };
  const social = {
    isBlockedEitherWay: jest.fn(),
    isFollowing: jest.fn(),
  };
  const events = { emit: jest.fn() };
  const service = () =>
    new ScheduledLivesService(
      prisma as unknown as PrismaService,
      social as unknown as SocialService,
      events as unknown as EventEmitter2,
    );
  const host = { id: 'host-1', username: 'abebe', displayName: 'Abebe', avatarUrl: null };
  const row = (
    id: string,
    visibility: StreamVisibility = StreamVisibility.PUBLIC,
    hostId = 'host-1',
  ) => ({
    id,
    title: `Live ${id}`,
    category: 'Poker',
    visibility,
    startsAt: inMinutes(60),
    hostId,
    host: { ...host, id: hostId },
    _count: { reminders: 2 },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    social.isBlockedEitherWay.mockResolvedValue(false);
    social.isFollowing.mockResolvedValue(false);
    prisma.scheduledLive.count.mockResolvedValue(0);
    prisma.scheduledLiveReminder.findMany.mockResolvedValue([]);
  });

  describe('scheduling', () => {
    it('announces a live with its title, category, audience and time', async () => {
      prisma.scheduledLive.create.mockResolvedValue(row('e1', StreamVisibility.FRIENDS));

      const created = await service().create(
        'host-1',
        {
          title: '  Friday poker ',
          category: ' Poker ',
          visibility: StreamVisibility.FRIENDS,
          startsAt: inMinutes(60),
        },
        now,
      );

      expect(prisma.scheduledLive.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            hostId: 'host-1',
            title: 'Friday poker',
            category: 'Poker',
            visibility: StreamVisibility.FRIENDS,
            startsAt: inMinutes(60),
          },
        }),
      );
      expect(created).toMatchObject({ id: 'e1', reminderCount: 2, reminded: false });
    });

    it('needs a time a few minutes to 30 days ahead', async () => {
      const create = (startsAt: Date) => service().create('host-1', { title: 'x', startsAt }, now);

      await expect(create(inMinutes(2))).rejects.toThrow(BadRequestException);
      await expect(create(inMinutes(-10))).rejects.toThrow(BadRequestException);
      await expect(create(inMinutes(31 * 24 * 60))).rejects.toThrow(BadRequestException);
      expect(prisma.scheduledLive.create).not.toHaveBeenCalled();
    });

    it('caps how many a host has coming up', async () => {
      prisma.scheduledLive.count.mockResolvedValue(10);

      await expect(
        service().create('host-1', { title: 'x', startsAt: inMinutes(60) }, now),
      ).rejects.toThrow(ConflictException);
    });

    it("only the host cancels it, and only while it's coming up", async () => {
      prisma.scheduledLive.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await expect(service().cancel('e1', 'host-1')).resolves.toEqual({ ok: true });
      expect(prisma.scheduledLive.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'e1', hostId: 'host-1', cancelledAt: null, streamId: null },
        }),
      );
      await expect(service().cancel('e1', 'someone-else')).rejects.toThrow(NotFoundException);
    });
  });

  describe('who sees them', () => {
    it("a host's profile shows each viewer what they may watch, with their own reminders", async () => {
      prisma.scheduledLive.findMany.mockResolvedValue([
        row('public'),
        row('followers', StreamVisibility.FOLLOWERS),
        row('friends', StreamVisibility.FRIENDS),
      ]);
      // viewer follows the host, who doesn't follow back.
      social.isFollowing.mockImplementation(async (follower: string) => follower === 'viewer-1');
      prisma.scheduledLiveReminder.findMany.mockResolvedValue([{ scheduledLiveId: 'followers' }]);

      const { items } = await service().ofHost('host-1', 'viewer-1', now);

      expect(items.map((item) => [item.id, item.reminded])).toEqual([
        ['public', false],
        ['followers', true],
      ]);
    });

    it('someone signed out sees only public ones; someone blocked sees none', async () => {
      prisma.scheduledLive.findMany.mockResolvedValue([
        row('public'),
        row('friends', StreamVisibility.FRIENDS),
      ]);
      expect(
        (await service().ofHost('host-1', undefined, now)).items.map((item) => item.id),
      ).toEqual(['public']);

      social.isBlockedEitherWay.mockResolvedValue(true);
      expect((await service().ofHost('host-1', 'viewer-1', now)).items).toEqual([]);
    });

    it("the Following tab lists the coming week's lives of followed hosts", async () => {
      prisma.follow.findMany.mockResolvedValue([{ followeeId: 'host-1' }]);
      prisma.scheduledLive.findMany.mockResolvedValue([row('e1')]);

      const { items } = await service().following('viewer-1', now);

      expect(items.map((item) => item.id)).toEqual(['e1']);
      const where = prisma.scheduledLive.findMany.mock.calls[0][0].where;
      expect(where.hostId).toEqual({ in: ['host-1'] });
      expect(where.startsAt).toEqual({
        gte: new Date(now.getTime() - LATE_GRACE_MS),
        lte: inMinutes(7 * 24 * 60),
      });
    });

    it('following nobody, nothing to list', async () => {
      prisma.follow.findMany.mockResolvedValue([]);
      await expect(service().following('viewer-1', now)).resolves.toEqual({ items: [] });
      expect(prisma.scheduledLive.findMany).not.toHaveBeenCalled();
    });
  });

  describe('Remind me', () => {
    it('sets and clears a reminder, answering the new count', async () => {
      prisma.scheduledLive.findFirst.mockResolvedValue(row('e1'));
      prisma.scheduledLiveReminder.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

      await expect(service().setReminder('e1', 'viewer-1', true, now)).resolves.toEqual({
        reminded: true,
        reminderCount: 3,
      });
      expect(prisma.scheduledLiveReminder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: { scheduledLiveId: 'e1', userId: 'viewer-1' } }),
      );
      await expect(service().setReminder('e1', 'viewer-1', false, now)).resolves.toEqual({
        reminded: false,
        reminderCount: 2,
      });
    });

    it("not for a live the viewer couldn't watch, nor for the host's own", async () => {
      prisma.scheduledLive.findFirst.mockResolvedValue(row('e1', StreamVisibility.FRIENDS));
      await expect(service().setReminder('e1', 'viewer-1', true, now)).rejects.toThrow(
        NotFoundException,
      );

      prisma.scheduledLive.findFirst.mockResolvedValue(row('e1'));
      await expect(service().setReminder('e1', 'host-1', true, now)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.scheduledLiveReminder.upsert).not.toHaveBeenCalled();
    });

    it('nothing to remind of once it was cancelled, started or long past', async () => {
      prisma.scheduledLive.findFirst.mockResolvedValue(null);
      await expect(service().setReminder('e1', 'viewer-1', true, now)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('starting soon', () => {
    it('reminds once, shortly before, each live that has people waiting', async () => {
      prisma.scheduledLive.findMany.mockResolvedValue([
        {
          id: 'e1',
          hostId: 'host-1',
          title: 'Poker',
          startsAt: inMinutes(8),
          visibility: 'PUBLIC',
        },
        {
          id: 'e2',
          hostId: 'host-2',
          title: 'Chess',
          startsAt: inMinutes(9),
          visibility: 'PUBLIC',
        },
        { id: 'e3', hostId: 'host-3', title: 'Dice', startsAt: inMinutes(5), visibility: 'PUBLIC' },
      ]);
      // e2 was claimed by another instance; e3 has nobody waiting.
      prisma.scheduledLive.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.scheduledLiveReminder.findMany
        .mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }])
        .mockResolvedValueOnce([]);

      await expect(service().sendDueReminders(now)).resolves.toBe(1);

      expect(prisma.scheduledLive.findMany.mock.calls[0][0].where).toMatchObject({
        remindedAt: null,
        cancelledAt: null,
        streamId: null,
        startsAt: { lte: new Date(now.getTime() + REMIND_BEFORE_MS) },
      });
      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.ScheduledLiveStartingSoon, {
        scheduledLiveId: 'e1',
        hostId: 'host-1',
        title: 'Poker',
        startsAt: inMinutes(8),
        userIds: ['u1', 'u2'],
      });
    });
  });
});
