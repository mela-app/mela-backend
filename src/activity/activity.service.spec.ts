import { SessionPlatform } from '@prisma/client';
import { LivePresenceService } from '../common/presence/live-presence.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ActivityService, appClientOf, installSource, utcDay } from './activity.service';
import { LiveStatsService } from './live-stats.service';

describe('what the app says about itself', () => {
  it('reads its platform, version and build, ignoring anything odd', () => {
    expect(
      appClientOf({
        'x-mela-platform': 'android',
        'x-mela-app-version': '1.0.5',
        'x-mela-app-build': '12',
      }),
    ).toEqual({ platform: SessionPlatform.ANDROID, version: '1.0.5', build: 12 });
    expect(
      appClientOf({
        'x-mela-platform': 'WEB',
        'x-mela-app-version': '1.0; drop',
        'x-mela-app-build': '-1',
      }),
    ).toEqual({});
    expect(appClientOf({})).toEqual({});
  });

  it('tells where an install came from out of the Play referrer', () => {
    expect(installSource('mela_open=live%2F0f9e4a1e-1111-4a3b-9c8d-123456789abc')).toBe(
      'shared_live',
    );
    expect(installSource('utm_source=x&mela_open=profile%2Fabc')).toBe('shared_profile');
    expect(installSource('utm_source=google-play&utm_medium=organic')).toBe('play_store');
    expect(installSource('utm_source=telegram_ad&utm_campaign=launch')).toBe('campaign');
    expect(installSource(null)).toBe('other');
    expect(installSource('nonsense')).toBe('other');
  });
});

describe('ActivityService', () => {
  const now = new Date('2026-11-03T23:30:00Z');
  const prisma = {
    userActiveDay: { createMany: jest.fn() },
    userSession: { updateMany: jest.fn() },
    appInstall: { createMany: jest.fn() },
  };
  const client = { set: jest.fn() };
  const service = () =>
    new ActivityService(
      prisma as unknown as PrismaService,
      { getClient: () => client } as unknown as RedisService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    client.set.mockResolvedValue('OK');
  });

  it("notes the day once, with the app's version on the device's session", async () => {
    await service().touch(
      'u1',
      's1',
      { platform: SessionPlatform.ANDROID, version: '1.0.5', build: 12 },
      now,
    );

    expect(client.set).toHaveBeenCalledWith(
      'activity:2026-11-03:s1:1.0.5',
      '1',
      'EX',
      172800,
      'NX',
    );
    expect(prisma.userActiveDay.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'u1', day: utcDay(now), platform: SessionPlatform.ANDROID }],
      skipDuplicates: true,
    });
    expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', userId: 'u1' },
      data: { appVersion: '1.0.5', appBuild: 12, platform: SessionPlatform.ANDROID },
    });

    jest.clearAllMocks();
    client.set.mockResolvedValue(null);
    await service().touch('u1', 's1', { version: '1.0.5' }, now);
    expect(prisma.userActiveDay.createMany).not.toHaveBeenCalled();
  });

  it('never lets counting fail the request', async () => {
    prisma.userActiveDay.createMany.mockRejectedValueOnce(new Error('db down'));
    await expect(service().touch('u1', 's1', {}, now)).resolves.toBeUndefined();
  });

  it('records an install once, with where it came from', async () => {
    await service().recordInstall({
      installationId: 'install-1',
      referrer: 'utm_source=google-play&utm_medium=organic',
      installedAt: now,
      app: { platform: SessionPlatform.ANDROID, version: '1.0.5' },
    });

    expect(prisma.appInstall.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          installationId: 'install-1',
          source: 'play_store',
          installedAt: now,
        }),
      ],
      skipDuplicates: true,
    });
  });
});

describe('LiveStatsService', () => {
  const prisma = {
    stream: { findMany: jest.fn(), updateMany: jest.fn((args: unknown) => args) },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
  const presence = { viewerIds: jest.fn() };
  const multi = {
    sadd: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    scard: jest.fn().mockReturnThis(),
    exec: jest.fn(),
  };
  const client = { set: jest.fn(), multi: () => multi };
  const service = () =>
    new LiveStatsService(
      prisma as unknown as PrismaService,
      presence as unknown as LivePresenceService,
      { getClient: () => client } as unknown as RedisService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    client.set.mockResolvedValue('OK');
  });

  it('adds a minute per viewer, and how many different people watched', async () => {
    prisma.stream.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    presence.viewerIds.mockImplementation(async (id: string) =>
      id === 's1' ? ['a', 'b', 'c'] : [],
    );
    multi.exec.mockResolvedValue([
      [null, 3],
      [null, 1],
      [null, 5],
    ]);

    await service().meter(new Date('2026-11-03T10:00:30Z'));

    expect(multi.sadd).toHaveBeenCalledWith('stream:s1:watched', 'a', 'b', 'c');
    expect(prisma.stream.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.stream.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'LIVE' },
      data: { viewerMinutes: { increment: 3 }, uniqueViewers: 5 },
    });
  });

  it('counts each minute once, however many instances run', async () => {
    client.set.mockResolvedValue(null);
    await service().meter();
    expect(prisma.stream.findMany).not.toHaveBeenCalled();
  });
});
