import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { VideoProviderKind } from '@prisma/client';
import { DomainEvents } from '../common/events/domain-events';
import { LivePresenceService } from '../common/presence/live-presence.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { VideoProviderRegistry } from '../common/video-provider/video-provider.registry';
import { AgoraUsageClient, AgoraUsageError } from './agora-usage.client';
import { VideoControlService } from './video-control.service';
import { nextPeriodStart, periodStartOf, periodUsage, quotaView } from './video-quota';

const { AGORA, LIVEKIT } = VideoProviderKind;

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('the quota period', () => {
  it("is the calendar month (UTC) - Agora's free minutes restart on the 1st", () => {
    expect(periodStartOf(new Date('2026-10-22T10:00:00Z'))).toEqual(day('2026-10-01'));
    expect(nextPeriodStart(new Date('2026-10-22T10:00:00Z'))).toEqual(day('2026-11-01'));
    expect(nextPeriodStart(new Date('2026-12-31T23:59:00Z'))).toEqual(day('2027-01-01'));
  });

  it("takes Agora's figures for the days it has finished, Mela's count for the rest", () => {
    const usage = periodUsage([
      // Reported the next afternoon: final.
      {
        day: day('2026-10-20'),
        countedMinutes: 900,
        reportedMinutes: 1_000,
        reportedAt: new Date('2026-10-21T12:00:00Z'),
      },
      {
        day: day('2026-10-21'),
        countedMinutes: 500,
        reportedMinutes: 480,
        reportedAt: new Date('2026-10-22T08:00:00Z'),
      },
      // Fetched an hour after the day ended - may still grow: the higher of the two.
      {
        day: day('2026-10-22'),
        countedMinutes: 300,
        reportedMinutes: 120,
        reportedAt: new Date('2026-10-22T10:00:00Z'),
      },
      { day: day('2026-10-23'), countedMinutes: 40, reportedMinutes: null, reportedAt: null },
    ]);
    expect(usage).toEqual({
      usedMinutes: 1_000 + 480 + 300 + 40,
      reportedMinutes: 1_480,
      pendingMinutes: 340,
      reportedThrough: day('2026-10-21'),
    });
  });

  it('says what is left, and when it runs out at this pace - only before the reset', () => {
    const now = new Date('2026-10-22T10:00:00Z');
    const resets = new Date('2026-11-01T00:00:00Z');
    expect(quotaView(10_000, 9_400, 10, now, resets)).toEqual({
      freeMinutes: 10_000,
      usedMinutes: 9_400,
      remainingMinutes: 600,
      percentUsed: 94,
      burnPerMinute: 10,
      runsOutAt: new Date('2026-10-22T11:00:00Z'),
    });
    expect(quotaView(10_000, 100, 0.5, now, resets).runsOutAt).toBeNull();
    expect(quotaView(10_000, 12_000, 0, now, resets).remainingMinutes).toBe(0);
  });
});

describe('VideoControlService', () => {
  const now = new Date('2026-10-22T10:00:30Z');
  let active: VideoProviderKind;
  const registry = {
    get activeProvider() {
      return active;
    },
    isConfigured: jest.fn(() => true),
    setActive: jest.fn((kind: VideoProviderKind) => {
      active = kind;
    }),
  };
  const prisma = {
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    videoSettings: { findUnique: jest.fn(), upsert: jest.fn() },
    videoUsageDay: { findMany: jest.fn(), upsert: jest.fn() },
    videoProviderSwitch: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    stream: { findMany: jest.fn(), groupBy: jest.fn().mockResolvedValue([]) },
    streamGuest: { count: jest.fn() },
  };
  const presence = { viewerCounts: jest.fn() };
  const redisClient = { set: jest.fn(), del: jest.fn() };
  const redis = { getClient: () => redisClient };
  const events = { emit: jest.fn() };
  const agoraUsage = { isConfigured: true, dailyMinutes: jest.fn() };
  const service = () =>
    new VideoControlService(
      prisma as unknown as PrismaService,
      registry as unknown as VideoProviderRegistry,
      presence as unknown as LivePresenceService,
      redis as unknown as RedisService,
      events as unknown as EventEmitter2,
      agoraUsage as unknown as AgoraUsageClient,
    );
  const settings = (overrides: Record<string, unknown> = {}) => ({
    activeProvider: AGORA,
    agoraFreeMinutes: 10_000,
    autoSwitch: false,
    autoSwitchBelowMinutes: 500,
    switchBackOnReset: true,
    autoSwitchedAt: null,
    agoraReportedAt: null,
    agoraReportError: null,
    ...overrides,
  });
  // Two lives on Agora: 10 and 4 viewers, one guest on stage.
  const twoLives = () => {
    prisma.stream.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    presence.viewerCounts.mockResolvedValue(
      new Map([
        ['s1', 10],
        ['s2', 4],
      ]),
    );
    prisma.streamGuest.count.mockResolvedValue(1);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    active = AGORA;
    registry.isConfigured.mockReturnValue(true);
    prisma.videoSettings.findUnique.mockResolvedValue(settings());
    prisma.videoUsageDay.findMany.mockResolvedValue([]);
    agoraUsage.isConfigured = true;
    prisma.stream.findMany.mockResolvedValue([]);
    redisClient.set.mockResolvedValue('OK');
  });

  it('switches where new lives go, saved for every instance, and records who did it', async () => {
    await service().switchTo({ id: 'staff-1' }, LIVEKIT, 'Saving Agora minutes');

    expect(registry.setActive).toHaveBeenCalledWith(LIVEKIT);
    expect(prisma.videoSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { activeProvider: LIVEKIT, autoSwitchedAt: null, updatedById: 'staff-1' },
      }),
    );
    expect(prisma.videoProviderSwitch.create).toHaveBeenCalledWith({
      data: { from: AGORA, to: LIVEKIT, actorId: 'staff-1', reason: 'Saving Agora minutes' },
    });
    expect(events.emit).toHaveBeenCalledWith(DomainEvents.VideoProviderSwitched, {
      from: AGORA,
      to: LIVEKIT,
      actorId: 'staff-1',
      reason: 'Saving Agora minutes',
    });
  });

  it("refuses a provider that isn't set up, or the one already in use", async () => {
    registry.isConfigured.mockReturnValue(false);
    await expect(service().switchTo({ id: 'staff-1' }, LIVEKIT, 'x')).rejects.toThrow(
      BadRequestException,
    );
    registry.isConfigured.mockReturnValue(true);
    await expect(service().switchTo({ id: 'staff-1' }, AGORA, 'x')).rejects.toThrow(
      'already go to Agora',
    );
    expect(registry.setActive).not.toHaveBeenCalled();
  });

  it('counts a minute for everyone on a live on Agora - once a minute, however many instances', async () => {
    twoLives();

    await service().meter(now);

    expect(prisma.stream.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'LIVE', videoProvider: AGORA } }),
    );
    expect(prisma.videoUsageDay.upsert).toHaveBeenCalledWith({
      where: { provider_day: { provider: AGORA, day: day('2026-10-22') } },
      create: { provider: AGORA, day: day('2026-10-22'), countedMinutes: 17 },
      update: { countedMinutes: { increment: 17 } },
    });
    expect(redisClient.set).toHaveBeenCalledWith(
      `video-usage:minute:${Math.floor(now.getTime() / 60_000)}`,
      '1',
      'EX',
      180,
      'NX',
    );

    jest.clearAllMocks();
    redisClient.set.mockResolvedValue(null);
    await service().meter(now);
    expect(prisma.videoUsageDay.upsert).not.toHaveBeenCalled();
  });

  it('moves new lives to LiveKit by itself when the free minutes run low - when asked to', async () => {
    twoLives();
    prisma.videoSettings.findUnique.mockResolvedValue(settings({ autoSwitch: true }));
    prisma.videoUsageDay.findMany.mockResolvedValue([
      { day: day('2026-10-22'), countedMinutes: 9_550, reportedMinutes: null, reportedAt: null },
    ]);

    await service().meter(now);

    expect(registry.setActive).toHaveBeenCalledWith(LIVEKIT);
    expect(prisma.videoProviderSwitch.create).toHaveBeenCalledWith({
      data: {
        from: AGORA,
        to: LIVEKIT,
        actorId: null,
        reason: "Agora's free minutes ran low (450 left)",
      },
    });
  });

  it("doesn't, when the automatic switch is off", async () => {
    twoLives();
    prisma.videoUsageDay.findMany.mockResolvedValue([
      { day: day('2026-10-22'), countedMinutes: 9_990, reportedMinutes: null, reportedAt: null },
    ]);

    await service().meter(now);

    expect(registry.setActive).not.toHaveBeenCalled();
  });

  it('back to Agora when the free minutes restart, if the automatic switch left it', async () => {
    active = LIVEKIT;
    prisma.videoSettings.findUnique.mockResolvedValue(
      settings({
        activeProvider: LIVEKIT,
        autoSwitch: true,
        autoSwitchedAt: new Date('2026-09-28T12:00:00Z'),
      }),
    );

    await service().meter(now);

    expect(registry.setActive).toHaveBeenCalledWith(AGORA);
  });

  it("saves Agora's own report for each day of the month so far", async () => {
    agoraUsage.dailyMinutes.mockResolvedValue(
      new Map([
        ['2026-10-01', 1_200],
        ['2026-10-02', 300],
      ]),
    );

    await service().reportFromAgora(now);

    expect(agoraUsage.dailyMinutes).toHaveBeenCalledWith('2026-10-01', '2026-10-22');
    expect(prisma.videoUsageDay.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.videoUsageDay.upsert).toHaveBeenCalledWith({
      where: { provider_day: { provider: AGORA, day: day('2026-10-01') } },
      create: { provider: AGORA, day: day('2026-10-01'), reportedMinutes: 1_200, reportedAt: now },
      update: { reportedMinutes: 1_200, reportedAt: now },
    });
    expect(prisma.videoSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { agoraReportedAt: now, agoraReportError: null } }),
    );
    expect(redisClient.del).toHaveBeenCalledWith('video-usage:agora-report');
  });

  it('keeps why Agora refused, for the console - and Mela keeps counting', async () => {
    agoraUsage.dailyMinutes.mockRejectedValue(new AgoraUsageError('Agora refused the Customer ID'));

    await service().reportFromAgora(now);

    expect(prisma.videoUsageDay.upsert).not.toHaveBeenCalled();
    expect(prisma.videoSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { agoraReportError: 'Agora refused the Customer ID' } }),
    );
  });

  it('asks Agora nothing without its Customer ID and Secret, or while another instance is', async () => {
    agoraUsage.isConfigured = false;
    await service().reportFromAgora(now);
    agoraUsage.isConfigured = true;
    redisClient.set.mockResolvedValue(null);
    await service().reportFromAgora(now);

    expect(agoraUsage.dailyMinutes).not.toHaveBeenCalled();
  });

  it('follows a switch made on another instance', async () => {
    prisma.videoSettings.findUnique.mockResolvedValue({ activeProvider: LIVEKIT });

    await service().sync();

    expect(registry.setActive).toHaveBeenCalledWith(LIVEKIT);
  });
});
