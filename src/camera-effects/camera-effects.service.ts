import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CameraEffectKind, MakeupAudience, Prisma } from '@prisma/client';
import { CameraEffectChangedPayload, DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../common/storage/storage-provider.interface';
import {
  BeautyControl,
  cameraEffectKey,
  CameraEffectUploadType,
  isCameraEffectKey,
  NEW_FOR_MS,
  parseBeautyControls,
} from './camera-effects.rules';

const EFFECT_SELECT = {
  id: true,
  kind: true,
  name: true,
  categoryId: true,
  audience: true,
  fileUrl: true,
  fileSize: true,
  thumbnailUrl: true,
  imageUrl: true,
  controls: true,
  featured: true,
  published: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true } },
  createdBy: { select: { id: true, username: true } },
} as const;

export interface StaffActor {
  id: string;
}

/** What staff send to save an effect; uploaded files come as the keys they were given. */
export interface SaveCameraEffectInput {
  kind?: CameraEffectKind;
  name?: string;
  categoryId?: string | null;
  audience?: MakeupAudience;
  fileKey?: string;
  fileSize?: number;
  thumbnailKey?: string | null;
  imageKey?: string;
  controls?: unknown;
  featured?: boolean;
  published?: boolean;
  sortOrder?: number;
}

/**
 * The camera effects hosts can use (docs/features/camera-effects.md): face
 * and scene effects by category, makeup looks, green-screen backgrounds, and
 * the beauty rig the face-shape sliders drive - files for the AR engine
 * (DeepAR) that staff upload and publish; the app downloads each when first
 * used. Filters and basic beauty are drawn by the app itself.
 */
@Injectable()
export class CameraEffectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // --- The app -------------------------------------------------------------

  /** Everything published, as the app's panels show it - and the engine's key. */
  async catalog(now: Date = new Date()) {
    const [categories, rows] = await Promise.all([
      this.prisma.cameraEffectCategory.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true },
      }),
      this.prisma.cameraEffect.findMany({
        where: { published: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        select: EFFECT_SELECT,
      }),
    ]);
    const licenseKey = this.config.get<string>('DEEPAR_ANDROID_LICENSE_KEY')?.trim();
    const fresh = (createdAt: Date) => now.getTime() - createdAt.getTime() < NEW_FOR_MS;
    const item = (row: (typeof rows)[number]) => ({
      id: row.id,
      name: row.name,
      fileUrl: row.fileUrl,
      fileSize: row.fileSize,
      thumbnailUrl: row.thumbnailUrl,
      // Changes when it's replaced: the app's cached file is then stale.
      version: row.updatedAt.getTime(),
    });
    const beauty = rows.find((row) => row.kind === CameraEffectKind.BEAUTY && row.fileUrl);
    const effects = rows.filter((row) => row.kind === CameraEffectKind.EFFECT && row.fileUrl);
    return {
      // Null: the app shows only what it draws itself (filters, basic beauty).
      engine: licenseKey ? { kind: 'DEEPAR', androidLicenseKey: licenseKey } : null,
      // Only categories with something in them.
      categories: categories.filter((category) =>
        effects.some((effect) => effect.categoryId === category.id),
      ),
      effects: effects.map((row) => ({
        ...item(row),
        categoryId: row.categoryId,
        trending: row.featured,
        isNew: fresh(row.createdAt),
      })),
      makeup: rows
        .filter((row) => row.kind === CameraEffectKind.MAKEUP && row.fileUrl)
        .map((row) => ({ ...item(row), audience: row.audience })),
      backgrounds: rows
        .filter((row) => row.kind === CameraEffectKind.BACKGROUND && row.imageUrl)
        .map((row) => ({
          id: row.id,
          name: row.name,
          imageUrl: row.imageUrl,
          thumbnailUrl: row.thumbnailUrl ?? row.imageUrl,
        })),
      beauty: beauty
        ? {
            ...item(beauty),
            controls: (beauty.controls as unknown as BeautyControl[] | null) ?? [],
          }
        : null,
    };
  }

  // --- Staff -----------------------------------------------------------------

  /** Every effect of [kind], drafts too. */
  async list(kind?: CameraEffectKind) {
    return this.prisma.cameraEffect.findMany({
      where: kind ? { kind } : {},
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: EFFECT_SELECT,
    });
  }

  /** A presigned upload for one file or picture about to be attached to an effect. */
  async uploadUrl(contentType: CameraEffectUploadType) {
    const key = cameraEffectKey(contentType);
    return { ...(await this.storage.createUploadUrl(key, contentType)), key };
  }

  async create(staff: StaffActor, input: SaveCameraEffectInput) {
    const kind = input.kind;
    if (!kind) throw new BadRequestException('Pick what it is');
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Give it a name');
    const data = await this.dataFor(kind, input, null);
    this.assertComplete(kind, { ...data });
    const row = await this.prisma.cameraEffect.create({
      data: {
        ...data,
        kind,
        name,
        createdById: staff.id,
      } as Prisma.CameraEffectUncheckedCreateInput,
      select: EFFECT_SELECT,
    });
    await this.keepOneBeauty(row);
    this.changed(staff, 'created', 'effect', row.id, row.name);
    return row;
  }

  async update(staff: StaffActor, id: string, input: SaveCameraEffectInput) {
    const before = await this.prisma.cameraEffect.findUnique({
      where: { id },
      select: EFFECT_SELECT,
    });
    if (!before) throw new NotFoundException('Effect not found');
    const data = await this.dataFor(before.kind, input, before);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException('Give it a name');
      data.name = name;
    }
    this.assertComplete(before.kind, { ...before, ...data });
    const row = await this.prisma.cameraEffect.update({
      where: { id },
      data: data as Prisma.CameraEffectUncheckedUpdateInput,
      select: EFFECT_SELECT,
    });
    // A replaced file or picture is gone from storage once nothing points at it.
    const dropped = [
      before.fileUrl !== row.fileUrl ? before.fileUrl : null,
      before.thumbnailUrl !== row.thumbnailUrl ? before.thumbnailUrl : null,
      before.imageUrl !== row.imageUrl ? before.imageUrl : null,
    ].filter((url): url is string => Boolean(url));
    if (dropped.length) void this.storage.deleteUrls(dropped);
    await this.keepOneBeauty(row);
    this.changed(staff, 'updated', 'effect', row.id, row.name);
    return row;
  }

  async remove(staff: StaffActor, id: string) {
    const row = await this.prisma.cameraEffect.findUnique({ where: { id }, select: EFFECT_SELECT });
    if (!row) throw new NotFoundException('Effect not found');
    await this.prisma.cameraEffect.delete({ where: { id } });
    void this.storage.deleteUrls(
      [row.fileUrl, row.thumbnailUrl, row.imageUrl].filter((url): url is string => Boolean(url)),
    );
    this.changed(staff, 'deleted', 'effect', row.id, row.name);
    return { ok: true };
  }

  // --- Categories --------------------------------------------------------------

  async categories() {
    const rows = await this.prisma.cameraEffectCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        sortOrder: true,
        _count: { select: { effects: true } },
      },
    });
    return rows.map(({ _count, ...row }) => ({ ...row, effectCount: _count.effects }));
  }

  async saveCategory(
    staff: StaffActor,
    id: string | null,
    input: { name?: string; sortOrder?: number },
  ) {
    const name = input.name?.trim();
    if (id === null && !name) throw new BadRequestException('Give the category a name');
    try {
      const row = id
        ? await this.prisma.cameraEffectCategory.update({
            where: { id },
            data: {
              ...(name ? { name } : {}),
              ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
            },
            select: { id: true, name: true, sortOrder: true },
          })
        : await this.prisma.cameraEffectCategory.create({
            data: { name: name!, sortOrder: input.sortOrder ?? 0 },
            select: { id: true, name: true, sortOrder: true },
          });
      this.changed(staff, id ? 'updated' : 'created', 'category', row.id, row.name);
      return row;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002')
          throw new ConflictException('There is already a category with that name');
        if (error.code === 'P2025') throw new NotFoundException('Category not found');
      }
      throw error;
    }
  }

  /** Only an empty one: its effects would lose their place in the app. */
  async removeCategory(staff: StaffActor, id: string) {
    const row = await this.prisma.cameraEffectCategory.findUnique({
      where: { id },
      select: { id: true, name: true, _count: { select: { effects: true } } },
    });
    if (!row) throw new NotFoundException('Category not found');
    if (row._count.effects > 0) {
      throw new ConflictException('Move or delete its effects first');
    }
    await this.prisma.cameraEffectCategory.delete({ where: { id } });
    this.changed(staff, 'deleted', 'category', row.id, row.name);
    return { ok: true };
  }

  // --- Helpers -------------------------------------------------------------------

  /** The fields [input] sets on an effect of [kind] - uploads turned into their addresses. */
  private async dataFor(
    kind: CameraEffectKind,
    input: SaveCameraEffectInput,
    before: { categoryId: string | null } | null,
  ): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};
    if (input.fileKey !== undefined) {
      if (!isCameraEffectKey(input.fileKey, 'file'))
        throw new BadRequestException('Upload the .deepar file again');
      data.fileUrl = this.storage.publicUrl(input.fileKey);
      data.fileSize = input.fileSize ?? null;
    }
    if (input.thumbnailKey !== undefined) {
      if (input.thumbnailKey !== null && !isCameraEffectKey(input.thumbnailKey, 'image')) {
        throw new BadRequestException('Upload the picture again');
      }
      data.thumbnailUrl =
        input.thumbnailKey === null ? null : this.storage.publicUrl(input.thumbnailKey);
    }
    if (input.imageKey !== undefined) {
      if (!isCameraEffectKey(input.imageKey, 'image'))
        throw new BadRequestException('Upload the background again');
      data.imageUrl = this.storage.publicUrl(input.imageKey);
    }
    if (kind === CameraEffectKind.EFFECT && input.categoryId !== undefined) {
      if (input.categoryId) {
        const category = await this.prisma.cameraEffectCategory.findUnique({
          where: { id: input.categoryId },
          select: { id: true },
        });
        if (!category) throw new NotFoundException('That category no longer exists');
      }
      data.categoryId = input.categoryId;
    } else if (kind === CameraEffectKind.EFFECT && before === null) {
      data.categoryId = null;
    }
    if (kind === CameraEffectKind.MAKEUP && input.audience !== undefined)
      data.audience = input.audience;
    if (kind === CameraEffectKind.BEAUTY && input.controls !== undefined) {
      const parsed = parseBeautyControls(input.controls);
      if ('error' in parsed) throw new BadRequestException(parsed.error);
      data.controls = parsed.controls as unknown as Prisma.InputJsonValue;
    }
    if (input.featured !== undefined)
      data.featured = kind === CameraEffectKind.EFFECT && input.featured;
    if (input.published !== undefined) data.published = input.published;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    return data;
  }

  // What the app can't do without, before it's published.
  private assertComplete(kind: CameraEffectKind, row: Record<string, unknown>) {
    if (!row.published) return;
    if (kind === CameraEffectKind.BACKGROUND) {
      if (!row.imageUrl)
        throw new BadRequestException('Upload the background picture before publishing');
      return;
    }
    if (!row.fileUrl) throw new BadRequestException('Upload the .deepar file before publishing');
    if (kind === CameraEffectKind.EFFECT && !row.categoryId) {
      throw new BadRequestException('Pick a category before publishing');
    }
    if (kind !== CameraEffectKind.BEAUTY && !row.thumbnailUrl) {
      throw new BadRequestException('Upload a thumbnail before publishing');
    }
  }

  // One beauty rig in the app: publishing one unpublishes the others.
  private async keepOneBeauty(row: { id: string; kind: CameraEffectKind; published: boolean }) {
    if (row.kind !== CameraEffectKind.BEAUTY || !row.published) return;
    await this.prisma.cameraEffect.updateMany({
      where: { kind: CameraEffectKind.BEAUTY, published: true, id: { not: row.id } },
      data: { published: false },
    });
  }

  private changed(
    staff: StaffActor,
    change: CameraEffectChangedPayload['change'],
    target: CameraEffectChangedPayload['target'],
    id: string,
    name: string,
  ) {
    this.events.emit(DomainEvents.CameraEffectChanged, {
      change,
      target,
      id,
      actorId: staff.id,
      name,
    } satisfies CameraEffectChangedPayload);
  }
}
