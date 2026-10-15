import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CameraEffectKind, MakeupAudience } from '@prisma/client';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageProvider } from '../common/storage/storage-provider.interface';
import { isCameraEffectKey, parseBeautyControls } from './camera-effects.rules';
import { CameraEffectsService } from './camera-effects.service';

const FILE = 'camera-effects/5f0c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c.deepar';
const PICTURE = 'camera-effects/0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b.png';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'fx-1',
  kind: CameraEffectKind.EFFECT,
  name: 'Football',
  categoryId: 'sports',
  audience: MakeupAudience.ALL,
  fileUrl: 'https://cdn.example.com/ball.deepar',
  fileSize: 2048,
  thumbnailUrl: 'https://cdn.example.com/ball.png',
  imageUrl: null,
  controls: null,
  featured: true,
  published: true,
  sortOrder: 0,
  createdAt: new Date('2026-10-14T09:00:00Z'),
  updatedAt: new Date('2026-10-14T09:00:00Z'),
  category: { id: 'sports', name: 'Sports' },
  createdBy: null,
  ...overrides,
});

describe('CameraEffectsService', () => {
  const now = new Date('2026-10-15T09:00:00Z');
  let settings: Record<string, string>;
  const prisma = {
    cameraEffect: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    cameraEffectCategory: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const events = { emit: jest.fn() };
  const storage = {
    createUploadUrl: jest.fn(),
    publicUrl: jest.fn((key: string) => `https://cdn.example.com/${key}`),
    deleteUrls: jest.fn(),
  };
  const service = () =>
    new CameraEffectsService(
      prisma as unknown as PrismaService,
      { get: (key: string) => settings[key] } as unknown as ConfigService,
      events as unknown as EventEmitter2,
      storage as unknown as StorageProvider,
    );
  const staff = { id: 'staff-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    settings = { DEEPAR_ANDROID_LICENSE_KEY: 'key-1' };
  });

  describe('the catalog', () => {
    it("gives the app what's published, by kind, with the engine's key", async () => {
      prisma.cameraEffectCategory.findMany.mockResolvedValue([
        { id: 'sports', name: 'Sports' },
        { id: 'empty', name: 'Empty' },
      ]);
      prisma.cameraEffect.findMany.mockResolvedValue([
        row(),
        row({ id: 'lips', kind: CameraEffectKind.MAKEUP, audience: MakeupAudience.FEMALE }),
        row({
          id: 'beach',
          kind: CameraEffectKind.BACKGROUND,
          fileUrl: null,
          imageUrl: 'https://cdn.example.com/beach.jpg',
          thumbnailUrl: null,
        }),
        row({ id: 'rig', kind: CameraEffectKind.BEAUTY, controls: [{ key: 'slim' }] }),
      ]);

      const catalog = await service().catalog(now);

      expect(prisma.cameraEffect.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { published: true } }),
      );
      expect(catalog.engine).toEqual({ kind: 'DEEPAR', androidLicenseKey: 'key-1' });
      expect(catalog.categories).toEqual([{ id: 'sports', name: 'Sports' }]);
      expect(catalog.effects).toEqual([
        expect.objectContaining({ id: 'fx-1', categoryId: 'sports', trending: true, isNew: true }),
      ]);
      expect(catalog.makeup).toEqual([expect.objectContaining({ id: 'lips', audience: 'FEMALE' })]);
      expect(catalog.backgrounds).toEqual([
        expect.objectContaining({ id: 'beach', thumbnailUrl: 'https://cdn.example.com/beach.jpg' }),
      ]);
      expect(catalog.beauty).toEqual(
        expect.objectContaining({ id: 'rig', controls: [{ key: 'slim' }] }),
      );
    });

    it('offers no engine without a license key', async () => {
      settings = {};
      prisma.cameraEffectCategory.findMany.mockResolvedValue([]);
      prisma.cameraEffect.findMany.mockResolvedValue([]);
      expect((await service().catalog(now)).engine).toBeNull();
    });
  });

  describe('staff', () => {
    it('saves an uploaded effect as a draft, its files as their addresses', async () => {
      prisma.cameraEffectCategory.findUnique.mockResolvedValue({ id: 'sports' });
      prisma.cameraEffect.create.mockResolvedValue(row({ published: false }));

      await service().create(staff, {
        kind: CameraEffectKind.EFFECT,
        name: ' Football ',
        categoryId: 'sports',
        fileKey: FILE,
        fileSize: 2048,
        thumbnailKey: PICTURE,
      });

      expect(prisma.cameraEffect.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: CameraEffectKind.EFFECT,
            name: 'Football',
            categoryId: 'sports',
            fileUrl: `https://cdn.example.com/${FILE}`,
            thumbnailUrl: `https://cdn.example.com/${PICTURE}`,
            createdById: 'staff-1',
          }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.CameraEffectChanged,
        expect.objectContaining({ change: 'created', target: 'effect' }),
      );
    });

    it("won't publish what the app can't use, nor take a key it didn't hand out", async () => {
      await expect(
        service().create(staff, { kind: CameraEffectKind.EFFECT, name: 'Ball', published: true }),
      ).rejects.toThrow('Upload the .deepar file before publishing');
      await expect(
        service().create(staff, {
          kind: CameraEffectKind.EFFECT,
          name: 'Ball',
          fileKey: 'avatars/x.deepar',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.cameraEffect.create).not.toHaveBeenCalled();
    });

    it('publishing a beauty rig unpublishes the others', async () => {
      prisma.cameraEffect.create.mockResolvedValue(
        row({ id: 'rig-2', kind: CameraEffectKind.BEAUTY, published: true }),
      );

      await service().create(staff, {
        kind: CameraEffectKind.BEAUTY,
        name: 'Beauty',
        fileKey: FILE,
        controls: [],
        published: true,
      });

      expect(prisma.cameraEffect.updateMany).toHaveBeenCalledWith({
        where: { kind: CameraEffectKind.BEAUTY, published: true, id: { not: 'rig-2' } },
        data: { published: false },
      });
    });

    it('replacing a file takes the old one out of storage', async () => {
      prisma.cameraEffect.findUnique.mockResolvedValue(row());
      prisma.cameraEffect.update.mockResolvedValue(
        row({ fileUrl: `https://cdn.example.com/${FILE}` }),
      );

      await service().update(staff, 'fx-1', { fileKey: FILE });

      expect(storage.deleteUrls).toHaveBeenCalledWith(['https://cdn.example.com/ball.deepar']);
    });

    it('deletes only an empty category', async () => {
      prisma.cameraEffectCategory.findUnique.mockResolvedValue({
        id: 'sports',
        name: 'Sports',
        _count: { effects: 2 },
      });
      await expect(service().removeCategory(staff, 'sports')).rejects.toThrow(ConflictException);
      expect(prisma.cameraEffectCategory.delete).not.toHaveBeenCalled();
    });
  });

  describe('the rules', () => {
    it('accepts only keys handed out for camera effects, of the right kind', () => {
      expect(isCameraEffectKey(FILE, 'file')).toBe(true);
      expect(isCameraEffectKey(FILE, 'image')).toBe(false);
      expect(isCameraEffectKey(PICTURE, 'image')).toBe(true);
      expect(isCameraEffectKey('camera-effects/../avatars/x.png', 'image')).toBe(false);
    });

    it('checks every beauty slider', () => {
      const good = {
        key: 'eye_size',
        label: 'Eyes',
        group: 'EYES',
        gameObject: 'Face',
        component: 'MeshRenderer',
        parameter: 'blendshape.eyes',
        to: 100,
      };
      expect(parseBeautyControls([good])).toEqual({ controls: [{ ...good, from: 0 }] });
      expect(parseBeautyControls([good, good])).toEqual({
        error: 'Control 2: key eye_size is used twice',
      });
      expect(parseBeautyControls([{ ...good, group: 'HAIR' }])).toEqual({
        error: 'Control 1: group must be one of FACE, EYES, NOSE, MOUTH',
      });
      expect(parseBeautyControls('nope')).toEqual({ error: 'Controls must be a list' });
    });
  });
});
