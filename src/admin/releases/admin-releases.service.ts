import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppPlatform, Prisma } from '@prisma/client';
import { compareVersions } from '../../app-releases/app-release.rules';
import { storeLink } from '../../app-releases/store-link';
import { AppReleaseChangedPayload, DomainEvents } from '../../common/events/domain-events';
import { PageQueryDto, pageArgs, toPage } from '../../common/pagination/page-query.dto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminPrincipal } from '../admin.guard';
import { PublishReleaseDto, UpdateReleaseDto } from './admin-releases.dto';

const RELEASE_SELECT = {
  id: true,
  platform: true,
  version: true,
  build: true,
  notes: true,
  downloadUrl: true,
  required: true,
  createdAt: true,
  updatedAt: true,
  publishedBy: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
} satisfies Prisma.AppReleaseSelect;

type ReleaseView = Prisma.AppReleaseGetPayload<{ select: typeof RELEASE_SELECT }>;

const PLATFORM_NAMES: Record<AppPlatform, string> = { ANDROID: 'Android', IOS: 'iOS' };

/**
 * App updates in the admin console (docs/features/app-updates.md): what was
 * published for each platform, and publishing, changing or withdrawing a
 * release. A release is a version and what's new in it - phones compare
 * versions and update from the store. Every change reaches the open apps at once.
 */
@Injectable()
export class AdminReleasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  /** Every release, the latest published first, and where each platform stands. */
  async list(query: PageQueryDto) {
    const [rows, total, android, ios] = await Promise.all([
      this.prisma.appRelease.findMany({
        orderBy: { createdAt: 'desc' },
        select: RELEASE_SELECT,
        ...pageArgs(query),
      }),
      this.prisma.appRelease.count(),
      this.platform(AppPlatform.ANDROID),
      this.platform(AppPlatform.IOS),
    ]);
    return { ...toPage(rows, total, query), platforms: { ANDROID: android, IOS: ios } };
  }

  /** Each version is newer than the last - the store won't take the same one twice either. */
  async publish(admin: AdminPrincipal, dto: PublishReleaseDto) {
    const name = PLATFORM_NAMES[dto.platform];
    if (!storeLink(this.config, dto.platform)) {
      throw new BadRequestException({
        message: `There's no ${name} store listing yet - set IOS_INSTALL_URL to the App Store page first`,
        code: 'NO_STORE_LINK',
      });
    }
    const newest = await this.newest(dto.platform);
    if (newest && compareVersions(dto.version, newest.version) <= 0) {
      throw new ConflictException({
        message: `Version ${dto.version} isn't newer than ${name} ${newest.version}`,
        code: 'VERSION_NOT_NEWER',
      });
    }

    const release = await this.prisma.appRelease.create({
      data: {
        platform: dto.platform,
        version: dto.version,
        notes: dto.notes,
        required: dto.required ?? false,
        publishedById: admin.id,
      },
      select: RELEASE_SELECT,
    });
    this.announce('published', admin, release);
    return release;
  }

  async update(admin: AdminPrincipal, releaseId: string, dto: UpdateReleaseDto) {
    const release = await this.find(releaseId);
    const data: Prisma.AppReleaseUpdateInput = {};
    if (dto.notes !== undefined && dto.notes !== release.notes) data.notes = dto.notes;
    if (dto.required !== undefined && dto.required !== release.required) {
      data.required = dto.required;
    }
    const fields = Object.keys(data);
    if (fields.length === 0) return release;

    const updated = await this.prisma.appRelease.update({
      where: { id: releaseId },
      data,
      select: RELEASE_SELECT,
    });
    this.announce('updated', admin, updated, fields);
    return updated;
  }

  /** Gone from what phones are told - published by mistake, or a bad build. */
  async withdraw(admin: AdminPrincipal, releaseId: string) {
    const release = await this.find(releaseId);
    const { count } = await this.prisma.appRelease.deleteMany({ where: { id: releaseId } });
    if (count === 0) throw new NotFoundException('Release not found');
    this.announce('withdrawn', admin, release);
    return { ok: true };
  }

  private async find(releaseId: string): Promise<ReleaseView> {
    const release = await this.prisma.appRelease.findUnique({
      where: { id: releaseId },
      select: RELEASE_SELECT,
    });
    if (!release) throw new NotFoundException('Release not found');
    return release;
  }

  private async platform(platform: AppPlatform) {
    const releases = await this.releasesOf(platform);
    return {
      latest: releases.at(0) ?? null,
      // Versions below this one can't be used.
      required: releases.find((release) => release.required) ?? null,
      // Where phones get it - null until there's a listing (iOS).
      storeLink: storeLink(this.config, platform),
      // To start the next release's form with: the next patch version.
      suggestedVersion: releases.at(0) ? nextPatch(releases[0].version) : '1.0.0',
    };
  }

  private async newest(platform: AppPlatform): Promise<ReleaseView | null> {
    return (await this.releasesOf(platform)).at(0) ?? null;
  }

  // Newest version first - not the order they were published in.
  private async releasesOf(platform: AppPlatform): Promise<ReleaseView[]> {
    const releases = await this.prisma.appRelease.findMany({
      where: { platform },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: RELEASE_SELECT,
    });
    return releases.sort((a, b) => compareVersions(b.version, a.version));
  }

  private announce(
    change: AppReleaseChangedPayload['change'],
    admin: AdminPrincipal,
    release: ReleaseView,
    fields?: string[],
  ) {
    this.events.emit(DomainEvents.AppReleaseChanged, {
      change,
      releaseId: release.id,
      actorId: admin.id,
      platform: release.platform,
      version: release.version,
      build: release.build,
      required: release.required,
      ...(fields ? { fields } : {}),
    } satisfies AppReleaseChangedPayload);
  }
}

/** 1.2.0 -> 1.2.1. */
function nextPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}
