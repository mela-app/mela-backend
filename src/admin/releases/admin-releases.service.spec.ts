import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppPlatform, PlatformRole, Prisma } from '@prisma/client';
import { DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminPrincipal } from '../admin.guard';
import { AdminReleasesService } from './admin-releases.service';

const admin = { id: 'admin-1', platformRole: PlatformRole.SUPER_ADMIN } as AdminPrincipal;
const release = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  platform: AppPlatform.ANDROID,
  version: '1.2.0',
  build: 12,
  notes: 'Faster lives',
  downloadUrl: 'https://example.com/mela-12.apk',
  required: false,
  createdAt: new Date('2026-10-05T09:00:00.000Z'),
  updatedAt: new Date('2026-10-05T09:00:00.000Z'),
  publishedBy: null,
  ...overrides,
});
const publish = {
  platform: AppPlatform.ANDROID,
  version: '1.3.0',
  build: 13,
  notes: 'Live chat search',
  downloadUrl: 'https://example.com/mela-13.apk',
};

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
  const config = { get: jest.fn() };
  const events = { emit: jest.fn() };
  const service = () =>
    new AdminReleasesService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      events as unknown as EventEmitter2,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.appRelease.findFirst.mockResolvedValue(null);
    prisma.appRelease.findUnique.mockResolvedValue(release());
  });

  describe('publish', () => {
    it('publishes a newer build and tells the open apps', async () => {
      prisma.appRelease.findFirst.mockResolvedValue({ version: '1.2.0', build: 12 });
      prisma.appRelease.create.mockResolvedValue(
        release({ id: 'r2', version: '1.3.0', build: 13, required: true }),
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
        build: 13,
        required: true,
      });
    });

    it('refuses a build that is not newer, or a lower version', async () => {
      prisma.appRelease.findFirst.mockResolvedValue({ version: '1.2.0', build: 12 });

      await expect(service().publish(admin, { ...publish, build: 12 })).rejects.toThrow(
        "Build 12 isn't newer than Android 1.2.0 (build 12)",
      );
      await expect(service().publish(admin, { ...publish, version: '1.1.9' })).rejects.toThrow(
        'Version 1.1.9 is older than Android 1.2.0',
      );
      expect(prisma.appRelease.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('the same build published at the same moment is a conflict, not an error', async () => {
      prisma.appRelease.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service().publish(admin, publish)).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a plain http download link', async () => {
      await expect(
        service().publish(admin, { ...publish, downloadUrl: 'http://example.com/mela.apk' }),
      ).rejects.toBeInstanceOf(BadRequestException);
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
      expect.objectContaining({ change: 'withdrawn', releaseId: 'r1', build: 12 }),
    );
  });

  it('lists releases with where each platform stands', async () => {
    const required = release({ id: 'r0', version: '1.1.0', build: 10, required: true });
    prisma.appRelease.findMany.mockResolvedValue([release()]);
    prisma.appRelease.count.mockResolvedValue(1);
    prisma.appRelease.findFirst.mockImplementation(
      ({ where }: { where: { platform: AppPlatform; required?: boolean } }) =>
        Promise.resolve(where.platform === 'IOS' ? null : where.required ? required : release()),
    );
    config.get.mockImplementation((key: string) =>
      key === 'IOS_INSTALL_URL' ? 'https://apps.apple.com/app/id1' : undefined,
    );

    const page = await service().list({ page: 1, pageSize: 25 });

    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(page.platforms.ANDROID).toEqual({
      latest: release(),
      required,
      suggestedDownloadUrl: 'https://example.com/mela-12.apk',
    });
    expect(page.platforms.IOS).toEqual({
      latest: null,
      required: null,
      suggestedDownloadUrl: 'https://apps.apple.com/app/id1',
    });
  });
});
