import { ConfigService } from '@nestjs/config';
import { AppPlatform } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppReleasesService, CHANGES_SHOWN } from './app-releases.service';

const published = (day: number) =>
  new Date(`2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`);
// Published since versions are compared: no build, no link of its own.
const release = (version: string, day: number, fields: object = {}) => ({
  version,
  build: null,
  notes: `What's new in ${version}`,
  downloadUrl: null,
  required: false,
  createdAt: published(day),
  ...fields,
});
const PLAY = 'https://play.google.com/store/apps/details?id=com.melalive.app';

describe('AppReleasesService', () => {
  const prisma = { appRelease: { findMany: jest.fn() } };
  const settings: Record<string, string> = { ANDROID_APP_PACKAGE_NAME: 'com.melalive.app' };
  const config = {
    get: (key: string) => settings[key],
    getOrThrow: (key: string) => settings[key],
  };
  const service = () =>
    new AppReleasesService(prisma as unknown as PrismaService, config as unknown as ConfigService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.appRelease.findMany.mockResolvedValue([]);
  });

  it('a phone on the newest version is up to date, and hears what came with it', async () => {
    prisma.appRelease.findMany.mockResolvedValue([release('1.2.0', 4)]);

    const check = await service().check(AppPlatform.ANDROID, { version: '1.2.0', build: 12 });

    expect(check).toEqual({
      status: 'UP_TO_DATE',
      latest: null,
      changes: [],
      current: {
        version: '1.2.0',
        build: null,
        notes: "What's new in 1.2.0",
        publishedAt: published(4),
      },
    });
  });

  it('an older version is offered the newest, from Google Play, with everything new since', async () => {
    prisma.appRelease.findMany.mockResolvedValue([
      release('1.10.0', 6),
      release('1.2.0', 4),
      release('1.1.0', 2),
    ]);

    const check = await service().check(AppPlatform.ANDROID, { version: '1.1.0', build: 3 });

    expect(check.status).toBe('AVAILABLE');
    // 1.10.0 is newer than 1.2.0 - versions, not text.
    expect(check.latest).toEqual({
      version: '1.10.0',
      build: null,
      downloadUrl: PLAY,
      publishedAt: published(6),
    });
    expect(check.changes.map((change) => change.version)).toEqual(['1.10.0', '1.2.0']);
    expect(check.current?.version).toBe('1.1.0');
  });

  it('must update when any newer release is required - even one that is not the newest', async () => {
    prisma.appRelease.findMany.mockResolvedValue([
      release('1.3.0', 6),
      release('1.2.0', 4, { required: true }),
    ]);

    const check = await service().check(AppPlatform.ANDROID, { version: '1.1.0' });

    expect(check.status).toBe('REQUIRED');
    expect(check.latest?.version).toBe('1.3.0');
  });

  it('a version newer than anything published is up to date', async () => {
    prisma.appRelease.findMany.mockResolvedValue([release('1.2.0', 4, { required: true })]);

    const check = await service().check(AppPlatform.ANDROID, { version: '1.4.0' });

    expect(check).toMatchObject({ status: 'UP_TO_DATE', latest: null, current: null });
  });

  it('shows at most the latest releases', async () => {
    prisma.appRelease.findMany.mockResolvedValue(
      Array.from({ length: CHANGES_SHOWN + 3 }, (_, i) => release(`1.${i + 1}.0`, i + 1)),
    );

    const check = await service().check(AppPlatform.ANDROID, { version: '1.0.0' });

    expect(check.changes).toHaveLength(CHANGES_SHOWN);
    expect(check.changes[0].version).toBe(`1.${CHANGES_SHOWN + 3}.0`);
  });

  describe('an app from before versions were compared (it sends only its build)', () => {
    it('is behind everything published since, and keeps its own releases by build', async () => {
      prisma.appRelease.findMany.mockResolvedValue([
        release('1.3.0', 8),
        release('1.2.0', 4, { build: 12, downloadUrl: 'https://example.com/mela-12.apk' }),
        release('1.1.0', 2, { build: 10, downloadUrl: 'https://example.com/mela-10.apk' }),
      ]);

      const check = await service().check(AppPlatform.ANDROID, { build: 10 });

      expect(check.status).toBe('AVAILABLE');
      expect(check.changes.map((change) => change.version)).toEqual(['1.3.0', '1.2.0']);
      expect(check.latest?.downloadUrl).toBe(PLAY);
      expect(check.current?.version).toBe('1.1.0');
    });

    it('an older release with its own link keeps it', async () => {
      prisma.appRelease.findMany.mockResolvedValue([
        release('1.2.0', 4, { build: 12, downloadUrl: 'https://example.com/mela-12.apk' }),
      ]);

      const check = await service().check(AppPlatform.ANDROID, { build: 10 });

      expect(check.latest?.downloadUrl).toBe('https://example.com/mela-12.apk');
    });
  });

  it('no App Store listing yet: no link for iPhones', async () => {
    prisma.appRelease.findMany.mockResolvedValue([release('1.2.0', 4)]);

    const check = await service().check(AppPlatform.IOS, { version: '1.0.0' });

    expect(check.latest?.downloadUrl).toBeNull();
    expect(prisma.appRelease.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { platform: 'IOS' } }),
    );
  });
});
