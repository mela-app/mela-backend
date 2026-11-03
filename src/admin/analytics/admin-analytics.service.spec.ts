import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminAnalyticsService, parseDay } from './admin-analytics.service';

describe('AdminAnalyticsService', () => {
  const prisma = {
    $queryRaw: jest.fn(),
    appInstall: { groupBy: jest.fn() },
    user: { count: jest.fn(), findMany: jest.fn() },
    userActiveDay: { aggregate: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    stream: { groupBy: jest.fn() },
  };
  const service = () => new AdminAnalyticsService(prisma as unknown as PrismaService);
  const day = (iso: string, extra: Record<string, number> = {}) => ({
    day: iso,
    newUsers: 0,
    activeUsers: 0,
    lives: 0,
    liveMinutes: 0,
    viewerMinutes: 0,
    installs: 0,
    ...extra,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // days, platforms, cohorts - in the order the service asks.
    prisma.$queryRaw
      .mockResolvedValueOnce([
        day('2026-11-01', { newUsers: 3, lives: 2, viewerMinutes: 40, installs: 1 }),
        day('2026-11-02', { newUsers: 2, lives: 1, viewerMinutes: 10 }),
      ])
      .mockResolvedValueOnce([
        { platform: 'ANDROID', users: 90 },
        { platform: null, users: 10 },
      ])
      .mockResolvedValueOnce([
        {
          week: '2026-10-26',
          size: 10,
          d1: 4,
          d1Eligible: 8,
          d7: 0,
          d7Eligible: 0,
          d30: 0,
          d30Eligible: 0,
        },
      ]);
    prisma.appInstall.groupBy.mockResolvedValue([
      { source: 'play_store', _count: { _all: 2 } },
      { source: 'shared_live', _count: { _all: 5 } },
    ]);
    prisma.user.count.mockResolvedValue(500);
    prisma.userActiveDay.aggregate.mockResolvedValue({
      _min: { day: new Date('2026-11-01T00:00:00Z') },
    });
    prisma.userActiveDay.count.mockResolvedValue(20);
    prisma.userActiveDay.groupBy
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({ userId: `w${i}` })))
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ userId: `m${i}` })));
    prisma.stream.groupBy.mockResolvedValue([
      {
        hostId: 'h1',
        _count: { _all: 2 },
        _sum: { viewerMinutes: 40, uniqueViewers: 9, likeCount: 30 },
        _max: { peakViewerCount: 7 },
      },
      // Their account was deleted meanwhile: left out.
      { hostId: 'gone', _count: { _all: 1 }, _sum: {}, _max: {} },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'h1', username: 'ana', displayName: 'Ana' }]);
  });

  it('sums the days, counts active users and how many came back, and ranks hosts', async () => {
    const result = await service().overview(
      '2026-11-01',
      '2026-11-02',
      new Date('2026-11-03T08:00:00Z'),
    );

    expect(result.trackingSince).toBe('2026-11-01');
    expect(result.totals).toMatchObject({
      users: 500,
      newUsers: 5,
      lives: 3,
      viewerMinutes: 50,
      installs: 1,
      dailyActive: 20,
      weeklyActive: 50,
      monthlyActive: 100,
      stickiness: 20,
      monthlyByPlatform: [
        { platform: 'ANDROID', users: 90 },
        { platform: 'UNKNOWN', users: 10 },
      ],
    });
    // A window that hasn't passed for anyone yet: unknown, not 0%.
    expect(result.retention).toEqual([
      { week: '2026-10-26', size: 10, d1: 50, d7: null, d30: null },
    ]);
    expect(result.topHosts).toEqual([
      {
        host: { id: 'h1', username: 'ana', displayName: 'Ana' },
        lives: 2,
        viewerMinutes: 40,
        viewers: 9,
        likes: 30,
        peakViewers: 7,
      },
    ]);
    expect(result.installSources).toEqual([
      { source: 'shared_live', count: 5 },
      { source: 'play_store', count: 2 },
    ]);
  });

  it('refuses a backwards range, or one longer than three months', async () => {
    await expect(service().overview('2026-11-02', '2026-11-01')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service().overview('2026-01-01', '2026-11-01')).rejects.toThrow('92 days at most');
    expect(() => parseDay('2026-13-45')).toThrow(BadRequestException);
  });
});
