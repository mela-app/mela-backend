import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppPlatform, PlatformRole } from '@prisma/client';
import { DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminPrincipal } from '../admin.guard';
import { AdminReleasesService } from './admin-releases.service';

const admin = { id: 'admin-1', platformRole: PlatformRole.SUPER_ADMIN } as AdminPrincipal;
const release = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  platform: AppPlatform.ANDROID,
  version: '1.2.0',
  build: null,
  notes: 'Faster lives',
  downloadUrl: null,
  required: false,
  createdAt: new Date('2026-10-05T09:00:00.000Z'),
  updatedAt: new Date('2026-10-05T09:00:00.000Z'),
  publishedBy: null,
  ...overrides,
});
const publish = {
  platform: AppPlatform.ANDROID,
  version: '1.3.0',
  notes: 'Live chat search',
};
const PLAY = 'https://play.google.com/store/apps/details?id=com.melalive.app';

describe('AdminReleasesService', () => {
  const prisma = {
    appRelease: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const settings: Record<string, string | undefined> = {};
  const config = {
    get: (key: string) => settings[key],
    getOrThrow: (key: string) => settings[key] ?? 'com.melalive.app',
  };
  const events = { emit: jest.fn() };
  const service = () =>
    new AdminReleasesService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      events as unknown as EventEmitter2,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    delete settings.IOS_INSTALL_URL;
    prisma.appRelease.findMany.mockResolvedValue([]);
    prisma.appRelease.findUnique.mockResolvedValue(release());
  });

  describe('publish', () => {
    it('publishes a newer version - no build, no link - and tells the open apps', async () => {
      prisma.appRelease.findMany.mockResolvedValue([release()]);
      prisma.appRelease.create.mockResolvedValue(
        release({ id: 'r2', version: '1.3.0', required: true }),
      );

      await service().publish(admin, { ...publish, required: true });

      expect(prisma.appRelease.create.mock.calls[0][0].data).toEqual({
        ...publish,
        required: true,
        publishedById: 'admin-1',
      });
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.AppReleaseChanged, {
        change: 'published',
        releaseId: 'r2',
        actorId: 'admin-1',
        platform: 'ANDROID',
        version: '1.3.0',
        build: null,
        required: true,
      });
    });

    it('refuses a version that is not newer than the newest - by version, not by date', async () => {
      // 1.10.0 was published before 1.9.0, and is still the newest.
      prisma.appRelease.findMany.mockResolvedValue([
        release({ version: '1.9.0' }),
        release({ version: '1.10.0' }),
      ]);

      for (const version of ['1.10.0', '1.9.5', '1.2.0']) {
        await expect(service().publish(admin, { ...publish, version })).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'VERSION_NOT_NEWER' }),
        });
      }
      await service().publish(admin, { ...publish, version: '1.10.1' });
      expect(prisma.appRelease.create).toHaveBeenCalledTimes(1);
    });

    it('an iPhone update needs an App Store listing first', async () => {
      await expect(
        service().publish(admin, { ...publish, platform: AppPlatform.IOS }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'NO_STORE_LINK' }) });
      expect(prisma.appRelease.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('changes only what differs, and says what', async () => {
      prisma.appRelease.update.mockResolvedValue(release({ required: true }));

      await service().update(admin, 'r1', { notes: 'Faster lives', required: true });

      expect(prisma.appRelease.update.mock.calls[0][0].data).toEqual({ required: true });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.AppReleaseChanged,
        expect.objectContaining({ change: 'updated', required: true, fields: ['required'] }),
      );
    });

    it('nothing different changes nothing', async () => {
      const result = await service().update(admin, 'r1', { notes: 'Faster lives' });

      expect(result).toEqual(release());
      expect(prisma.appRelease.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('an unknown release is a 404', async () => {
      prisma.appRelease.findUnique.mockResolvedValue(null);

      await expect(service().update(admin, 'nope', { required: true })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('withdrawing removes the release and tells the open apps', async () => {
    prisma.appRelease.deleteMany.mockResolvedValue({ count: 1 });

    expect(await service().withdraw(admin, 'r1')).toEqual({ ok: true });
    expect(prisma.appRelease.deleteMany).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(events.emit).toHaveBeenCalledWith(
      DomainEvents.AppReleaseChanged,
      expect.objectContaining({ change: 'withdrawn', releaseId: 'r1', version: '1.2.0' }),
    );
  });

  it('lists releases with where each platform stands, and the next version to publish', async () => {
    const required = release({ id: 'r0', version: '1.1.0', required: true });
    prisma.appRelease.findMany.mockImplementation(
      ({ where }: { where?: { platform?: AppPlatform } }) =>
        Promise.resolve(where?.platform === 'IOS' ? [] : [required, release()]),
    );
    prisma.appRelease.count.mockResolvedValue(2);

    const page = await service().list({ page: 1, pageSize: 25 });

    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(page.platforms.ANDROID).toEqual({
      latest: release(),
      required,
      storeLink: PLAY,
      suggestedVersion: '1.2.1',
    });
    expect(page.platforms.IOS).toEqual({
      latest: null,
      required: null,
      storeLink: null,
      suggestedVersion: '1.0.0',
    });
  });
});
