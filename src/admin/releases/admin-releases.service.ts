import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppPlatform, Prisma } from '@prisma/client';
import { compareVersions, downloadUrlProblem } from '../../app-releases/app-release.rules';
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
 * release. Every change reaches the open apps at once.
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

  async publish(admin: AdminPrincipal, dto: PublishReleaseDto) {
    assertDownloadUrl(dto.downloadUrl);
    const name = PLATFORM_NAMES[dto.platform];
    const newest = await this.prisma.appRelease.findFirst({
      where: { platform: dto.platform },
      orderBy: { build: 'desc' },
      select: { version: true, build: true },
    });
    if (newest && dto.build <= newest.build) {
      throw new ConflictException({
        message: `Build ${dto.build} isn't newer than ${name} ${newest.version} (build ${newest.build})`,
        code: 'BUILD_NOT_NEWER',
      });
    }
    if (newest && compareVersions(dto.version, newest.version) < 0) {
      throw new ConflictException({
        message: `Version ${dto.version} is older than ${name} ${newest.version}`,
        code: 'VERSION_OLDER',
      });
    }

    let release: ReleaseView;
    try {
      release = await this.prisma.appRelease.create({
        data: {
          platform: dto.platform,
          version: dto.version,
          build: dto.build,
          notes: dto.notes,
          downloadUrl: dto.downloadUrl,
          required: dto.required ?? false,
          publishedById: admin.id,
        },
        select: RELEASE_SELECT,
      });
    } catch (error) {
      // Someone published the same build a moment earlier.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          message: `${name} build ${dto.build} is already published`,
          code: 'BUILD_NOT_NEWER',
        });
      }
      throw error;
    }
    this.announce('published', admin, release);
    return release;
  }

  async update(admin: AdminPrincipal, releaseId: string, dto: UpdateReleaseDto) {
    const release = await this.find(releaseId);
    if (dto.downloadUrl !== undefined) assertDownloadUrl(dto.downloadUrl);
    const data: Prisma.AppReleaseUpdateInput = {};
    if (dto.notes !== undefined && dto.notes !== release.notes) data.notes = dto.notes;
    if (dto.downloadUrl !== undefined && dto.downloadUrl !== release.downloadUrl) {
      data.downloadUrl = dto.downloadUrl;
    }
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
    const [latest, required] = await Promise.all([
      this.prisma.appRelease.findFirst({
        where: { platform },
        orderBy: { build: 'desc' },
        select: RELEASE_SELECT,
      }),
      this.prisma.appRelease.findFirst({
        where: { platform, required: true },
        orderBy: { build: 'desc' },
        select: RELEASE_SELECT,
      }),
    ]);
    return {
      latest,
      // Builds below this one can't be used.
      required,
      // To start the next release's form with.
      suggestedDownloadUrl: latest?.downloadUrl ?? this.installUrl(platform),
    };
  }

  private installUrl(platform: AppPlatform): string | null {
    const key = platform === AppPlatform.IOS ? 'IOS_INSTALL_URL' : 'ANDROID_INSTALL_URL';
    return this.config.get<string>(key) || null;
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

function assertDownloadUrl(url: string) {
  const problem = downloadUrlProblem(url);
  if (problem) throw new BadRequestException(problem);
}
