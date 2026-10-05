import { AppPlatform } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppReleasesService, CHANGES_SHOWN } from './app-releases.service';

const published = (day: number) => new Date(`2026-10-0${day}T09:00:00.000Z`);
const release = (version: string, build: number, day: number) => ({
  version,
  build,
  notes: `What's new in ${version}`,
  downloadUrl: `https://example.com/mela-${build}.apk`,
  createdAt: published(day),
});

describe('AppReleasesService', () => {
  const prisma = {
    appRelease: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  };
  const service = () => new AppReleasesService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.appRelease.findMany.mockResolvedValue([]);
    prisma.appRelease.findUnique.mockResolvedValue(null);
    prisma.appRelease.count.mockResolvedValue(0);
  });

  it('a phone on the newest build is up to date, and hears what came with it', async () => {
    prisma.appRelease.findUnique.mockResolvedValue(release('1.2.0', 12, 4));

    const check = await service().check(AppPlatform.ANDROID, 12);

    expect(check).toEqual({
      status: 'UP_TO_DATE',
      latest: null,
      changes: [],
      current: {
        version: '1.2.0',
        build: 12,
        notes: "What's new in 1.2.0",
        publishedAt: published(4),
      },
    });
    expect(prisma.appRelease.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { platform_build: { platform: 'ANDROID', build: 12 } } }),
    );
  });

  it('an older build is offered the newest release, with everything new since', async () => {
    prisma.appRelease.findMany.mockResolvedValue([
      release('1.2.0', 12, 4),
      release('1.1.0', 10, 2),
    ]);

    const check = await service().check(AppPlatform.ANDROID, 8);

    expect(check.status).toBe('AVAILABLE');
    expect(check.latest).toEqual({
      version: '1.2.0',
      build: 12,
      downloadUrl: 'https://example.com/mela-12.apk',
      publishedAt: published(4),
    });
    expect(check.changes.map((change) => change.version)).toEqual(['1.2.0', '1.1.0']);
    expect(check.current).toBeNull();
    expect(prisma.appRelease.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { platform: 'ANDROID', build: { gt: 8 } },
        orderBy: { build: 'desc' },
        take: CHANGES_SHOWN,
      }),
    );
  });

  it('must update when any newer release is required - even one that is not the newest', async () => {
    prisma.appRelease.findMany.mockResolvedValue([
      release('1.2.0', 12, 4),
      release('1.1.0', 10, 2),
    ]);
    prisma.appRelease.count.mockResolvedValue(1);

    const check = await service().check(AppPlatform.IOS, 8);

    expect(check.status).toBe('REQUIRED');
    expect(check.latest?.build).toBe(12);
    expect(prisma.appRelease.count).toHaveBeenCalledWith({
      where: { platform: 'IOS', build: { gt: 8 }, required: true },
    });
  });
});
