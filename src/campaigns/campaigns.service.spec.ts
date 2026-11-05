import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CampaignStatus, SessionPlatform } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PushQueueService } from '../notifications/push-queue.service';
import { audienceWhere, storedAudience } from './campaign-audience';
import { CAMPAIGN_PUSH_TYPE, CampaignsService, checkLink } from './campaigns.service';

const LIVE = '/live/0f9e4a1e-1111-4a3b-9c8d-123456789abc';

describe('a campaign audience', () => {
  const now = new Date('2026-11-03T10:00:00Z');

  it('narrows to phones that can get a push, from people who take announcements', () => {
    const where = audienceWhere(
      {
        platform: SessionPlatform.ANDROID,
        appVersions: ['1.0.3'],
        hostsOnly: true,
        inactiveForDays: 14,
      },
      now,
    );
    expect(where).toMatchObject({
      platformRole: 'USER',
      status: 'ACTIVE',
      sessions: {
        some: { pushToken: { not: null }, platform: 'ANDROID', appVersion: { in: ['1.0.3'] } },
      },
    });
    expect(where.AND).toEqual([
      {
        OR: [{ notificationSettings: null }, { notificationSettings: { pushAnnouncements: true } }],
      },
      { streams: { some: { startedAt: { gte: new Date('2026-10-04T10:00:00Z') } } } },
      { activeDays: { none: { day: { gte: new Date('2026-10-20T10:00:00Z') } } } },
    ]);
  });

  it('keeps only what was set', () => {
    expect(storedAudience({ hostsOnly: false, appVersions: [], activeWithinDays: 7 })).toEqual({
      activeWithinDays: 7,
    });
  });

  it("takes https links and the app's own lives and profiles - nothing else", () => {
    expect(() => checkLink('https://mela.live/get')).not.toThrow();
    expect(() => checkLink(LIVE)).not.toThrow();
    expect(() => checkLink('javascript:alert(1)')).toThrow(BadRequestException);
    expect(() => checkLink('http://insecure.example')).toThrow(BadRequestException);
  });
});

describe('CampaignsService', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  const prisma = {
    user: { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
    pushCampaign: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    pushCampaignOpen: { createMany: jest.fn() },
    announcement: { create: jest.fn(), findMany: jest.fn() },
    featuredHost: { aggregate: jest.fn(), upsert: jest.fn() },
  };
  const pushQueue = { enqueueMany: jest.fn() };
  const events = { emit: jest.fn() };
  const service = () =>
    new CampaignsService(
      prisma as unknown as PrismaService,
      pushQueue as unknown as PushQueueService,
      events as unknown as EventEmitter2,
    );
  const staff = { id: 'staff-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.pushCampaign.findMany.mockResolvedValue([]);
  });

  it('schedules for later, and records who did it', async () => {
    const later = new Date('2026-11-04T08:00:00Z');
    prisma.pushCampaign.create.mockResolvedValue({ id: 'c1', title: 'New feature' });

    await service().createCampaign(
      staff,
      {
        title: 'New feature',
        body: 'Try it',
        openPath: LIVE,
        audience: { hostsOnly: true },
        scheduledAt: later,
      },
      now,
    );

    expect(prisma.pushCampaign.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        openPath: LIVE,
        audience: { hostsOnly: true },
        scheduledAt: later,
        createdById: 'staff-1',
      }),
    });
    expect(events.emit).toHaveBeenCalledWith('campaign.scheduled', {
      campaignId: 'c1',
      actorId: 'staff-1',
      title: 'New feature',
    });
  });

  it('opens only a live or profile in the app', async () => {
    await expect(
      service().createCampaign(
        staff,
        { title: 't', body: 'b', openPath: '/settings', audience: {} },
        now,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('sends a due campaign once - claimed first - a batch at a time, then says how many it reached', async () => {
    const campaign = { id: 'c1', title: 'Hi', body: 'There', openPath: null, audience: {} };
    prisma.pushCampaign.findMany.mockResolvedValue([campaign]);
    prisma.pushCampaign.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'u1' }, { id: 'u2' }]);

    await service().sendDue(now);

    expect(prisma.pushCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: CampaignStatus.SCHEDULED },
      data: { status: CampaignStatus.SENDING },
    });
    expect(pushQueue.enqueueMany).toHaveBeenCalledWith([
      expect.objectContaining({
        recipientId: 'u1',
        data: { type: CAMPAIGN_PUSH_TYPE, campaignId: 'c1' },
      }),
      expect.objectContaining({ recipientId: 'u2', collapseKey: 'campaign:c1' }),
    ]);
    expect(prisma.pushCampaign.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({ status: CampaignStatus.SENT, recipientCount: 2 }),
    });
  });

  it('leaves a campaign another instance claimed', async () => {
    prisma.pushCampaign.findMany.mockResolvedValue([{ id: 'c1', audience: {} }]);
    prisma.pushCampaign.updateMany.mockResolvedValue({ count: 0 });

    await service().sendDue(now);

    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('marks a campaign that could not go out as failed', async () => {
    prisma.pushCampaign.findMany.mockResolvedValue([
      { id: 'c1', title: 't', body: 'b', audience: {} },
    ]);
    prisma.pushCampaign.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findMany.mockRejectedValue(new Error('db down'));
    prisma.pushCampaign.update.mockResolvedValue({});

    await service().sendDue(now);

    expect(prisma.pushCampaign.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({ status: CampaignStatus.FAILED }),
    });
  });

  it('cancels only before it goes out', async () => {
    prisma.pushCampaign.updateMany.mockResolvedValue({ count: 0 });
    prisma.pushCampaign.findUnique.mockResolvedValue({ id: 'c1' });

    await expect(service().cancelCampaign(staff, 'c1')).rejects.toThrow(ConflictException);
  });

  it('deletes a campaign - but not while it is going out', async () => {
    prisma.pushCampaign.findUnique.mockResolvedValue({ id: 'c1', title: 'Hi', status: 'SENT' });
    prisma.pushCampaign.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service().deleteCampaign(staff, 'c1')).resolves.toEqual({ ok: true });
    expect(prisma.pushCampaign.deleteMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: { not: 'SENDING' } },
    });

    prisma.pushCampaign.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service().deleteCampaign(staff, 'c1')).rejects.toThrow(ConflictException);

    prisma.pushCampaign.findUnique.mockResolvedValue(null);
    await expect(service().deleteCampaign(staff, 'c1')).rejects.toThrow(NotFoundException);
  });

  it('counts an open once per person', async () => {
    prisma.pushCampaign.findUnique.mockResolvedValue({ id: 'c1' });

    await service().recordOpen('u1', 'c1');

    expect(prisma.pushCampaignOpen.createMany).toHaveBeenCalledWith({
      data: [{ campaignId: 'c1', userId: 'u1' }],
      skipDuplicates: true,
    });
  });

  it('shows the app only the banners running now, on its platform', async () => {
    prisma.announcement.findMany.mockResolvedValue([]);

    await service().activeAnnouncements(SessionPlatform.ANDROID, now);

    expect(prisma.announcement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          startsAt: { lte: now },
          OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          AND: [{ OR: [{ platform: null }, { platform: SessionPlatform.ANDROID }] }],
        },
      }),
    );
  });

  it("doesn't feature a suspended account", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      status: 'SUSPENDED',
      platformRole: 'USER',
    });

    await expect(service().feature(staff, { userId: 'u1' })).rejects.toThrow('suspended');
    expect(prisma.featuredHost.upsert).not.toHaveBeenCalled();
  });

  it('adds a featured host at the end of the list', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', status: 'ACTIVE', platformRole: 'USER' });
    prisma.featuredHost.aggregate.mockResolvedValue({ _max: { position: 2 } });

    await service().feature(staff, { userId: 'u1', note: 'Launch week' });

    expect(prisma.featuredHost.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ position: 3, note: 'Launch week' }),
      }),
    );
  });
});
