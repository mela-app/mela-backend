import { Injectable } from '@nestjs/common';
import { AppPlatform } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

/** The newer releases a phone is told about, newest first. */
export const CHANGES_SHOWN = 10;

export type UpdateStatus = 'UP_TO_DATE' | 'AVAILABLE' | 'REQUIRED';

const CHANGE_SELECT = { version: true, build: true, notes: true, createdAt: true } as const;

/**
 * Whether a phone's copy of the app is current (docs/features/app-updates.md):
 * the releases the team published since its build, and whether one of them
 * is required.
 */
@Injectable()
export class AppReleasesService {
  constructor(private readonly prisma: PrismaService) {}

  async check(platform: AppPlatform, build: number) {
    const [newer, current, required] = await Promise.all([
      this.prisma.appRelease.findMany({
        where: { platform, build: { gt: build } },
        orderBy: { build: 'desc' },
        take: CHANGES_SHOWN,
        select: { ...CHANGE_SELECT, downloadUrl: true },
      }),
      this.prisma.appRelease.findUnique({
        where: { platform_build: { platform, build } },
        select: CHANGE_SELECT,
      }),
      this.prisma.appRelease.count({ where: { platform, build: { gt: build }, required: true } }),
    ]);
    const latest = newer.at(0);
    const status: UpdateStatus = required > 0 ? 'REQUIRED' : latest ? 'AVAILABLE' : 'UP_TO_DATE';
    return {
      status,
      latest: latest
        ? {
            version: latest.version,
            build: latest.build,
            downloadUrl: latest.downloadUrl,
            publishedAt: latest.createdAt,
          }
        : null,
      // What's new since this build.
      changes: newer.map(changeOf),
      // What came with this build - shown once after updating.
      current: current ? changeOf(current) : null,
    };
  }
}

function changeOf(release: { version: string; build: number; notes: string; createdAt: Date }) {
  return {
    version: release.version,
    build: release.build,
    notes: release.notes,
    publishedAt: release.createdAt,
  };
}
