import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppPlatform } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { compareVersions } from './app-release.rules';
import { storeLink } from './store-link';

/** The newer releases a phone is told about, newest first. */
export const CHANGES_SHOWN = 10;

/** Plenty for years of releases on one platform; each check reads them all. */
const RELEASES_READ = 500;

export type UpdateStatus = 'UP_TO_DATE' | 'AVAILABLE' | 'REQUIRED';

interface Installed {
  /** The installed version (1.2.0) - what releases are compared with. */
  version?: string;
  /** The installed build - sent by apps from before versions were compared. */
  build?: number;
}

const RELEASE_SELECT = {
  version: true,
  build: true,
  notes: true,
  downloadUrl: true,
  required: true,
  createdAt: true,
} as const;

type Release = {
  version: string;
  build: number | null;
  notes: string;
  downloadUrl: string | null;
  required: boolean;
  createdAt: Date;
};

/**
 * Whether a phone's copy of the app is current (docs/features/app-updates.md):
 * the releases the team published since its version, and whether one of
 * them is required. Phones get updates from the store - Google Play, or the
 * App Store - unless an older release named its own link.
 */
@Injectable()
export class AppReleasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async check(platform: AppPlatform, installed: Installed) {
    const releases: Release[] = await this.prisma.appRelease.findMany({
      where: { platform },
      orderBy: { createdAt: 'desc' },
      take: RELEASES_READ,
      select: RELEASE_SELECT,
    });
    const newer = releases
      .filter((release) => isNewer(release, installed))
      .sort((a, b) => compareVersions(b.version, a.version));
    const current = releases.find((release) =>
      installed.version !== undefined
        ? release.version === installed.version
        : release.build !== null && release.build === installed.build,
    );
    const latest = newer.at(0);
    const status: UpdateStatus = newer.some((release) => release.required)
      ? 'REQUIRED'
      : latest
        ? 'AVAILABLE'
        : 'UP_TO_DATE';
    return {
      status,
      latest: latest
        ? {
            version: latest.version,
            build: latest.build,
            downloadUrl: latest.downloadUrl ?? storeLink(this.config, platform),
            publishedAt: latest.createdAt,
          }
        : null,
      // What's new since this version.
      changes: newer.slice(0, CHANGES_SHOWN).map(changeOf),
      // What came with this version - shown once after updating.
      current: current ? changeOf(current) : null,
    };
  }
}

/**
 * Whether [release] is newer than the installed copy: by version - or, for
 * an app from before versions were compared (it sends only its build), by
 * build; a release published since has no build, and is newer than any such app.
 */
function isNewer(release: Release, installed: Installed): boolean {
  if (installed.version !== undefined)
    return compareVersions(release.version, installed.version) > 0;
  if (release.build === null) return true;
  return installed.build !== undefined && release.build > installed.build;
}

function changeOf(release: Release) {
  return {
    version: release.version,
    build: release.build,
    notes: release.notes,
    publishedAt: release.createdAt,
  };
}
