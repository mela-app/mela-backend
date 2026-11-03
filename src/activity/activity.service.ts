import { Injectable, Logger } from '@nestjs/common';
import { SessionPlatform } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

// A day's "seen" key outlives the day, so a request just after midnight UTC
// still finds yesterday's - and never writes it twice.
const SEEN_TTL_SECONDS = 2 * 24 * 60 * 60;

const VERSION = /^\d{1,4}(\.\d{1,4}){0,3}$/;

/** What the app says about itself on each request (X-Mela-* headers); empty for the web player and staff. */
export interface AppClient {
  platform?: SessionPlatform;
  version?: string;
  build?: number;
}

/** UTC midnight of [now]'s day. */
export function utcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Reads the app's own headers, ignoring anything malformed. */
export function appClientOf(headers: Record<string, unknown>): AppClient {
  const header = (name: string) => {
    const value = headers[name];
    return typeof value === 'string' ? value.trim() : undefined;
  };
  const platform = header('x-mela-platform')?.toUpperCase();
  const version = header('x-mela-app-version');
  const build = Number(header('x-mela-app-build'));
  return {
    ...(platform === SessionPlatform.ANDROID || platform === SessionPlatform.IOS
      ? { platform: platform as SessionPlatform }
      : {}),
    ...(version && VERSION.test(version) ? { version } : {}),
    ...(Number.isInteger(build) && build > 0 && build < 1_000_000 ? { build } : {}),
  };
}

/**
 * Where an install came from, out of Google Play's install referrer: a
 * shared live or profile (the get-Mela page adds `mela_open=`), the Play
 * Store itself, or a campaign link (utm_source).
 */
export function installSource(referrer: string | null | undefined): string {
  if (!referrer) return 'other';
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(referrer);
  } catch {
    return 'other';
  }
  const open = params.get('mela_open') ?? '';
  if (open.startsWith('live/')) return 'shared_live';
  if (open.startsWith('profile/')) return 'shared_profile';
  const medium = params.get('utm_medium');
  const source = params.get('utm_source');
  if (medium === 'organic' || source === 'google-play') return 'play_store';
  if (source) return 'campaign';
  return 'other';
}

/**
 * Who used Mela, and on what (docs/features/analytics.md): one row per
 * account per UTC day, written on its first request of the day - and the
 * app version a device runs, kept on its session. At most one write per
 * device per day (or per app update), whatever it sends.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async touch(
    userId: string,
    sessionId: string,
    app: AppClient,
    now: Date = new Date(),
  ): Promise<void> {
    const day = utcDay(now);
    const key = `activity:${day.toISOString().slice(0, 10)}:${sessionId}:${app.version ?? '-'}`;
    try {
      const first = await this.redis.getClient().set(key, '1', 'EX', SEEN_TTL_SECONDS, 'NX');
      if (first !== 'OK') return;
      await Promise.all([
        this.prisma.userActiveDay.createMany({
          data: [{ userId, day, platform: app.platform ?? null }],
          skipDuplicates: true,
        }),
        app.version
          ? this.prisma.userSession.updateMany({
              where: { id: sessionId, userId },
              data: {
                appVersion: app.version,
                appBuild: app.build ?? null,
                ...(app.platform ? { platform: app.platform } : {}),
              },
            })
          : null,
      ]);
    } catch (error) {
      // Counting is a nicety: the request itself goes on.
      this.logger.warn(`Activity not recorded: ${error}`);
    }
  }

  /** The app's report of where it was installed from - once per install; a resend changes nothing. */
  async recordInstall(input: {
    installationId: string;
    referrer?: string | null;
    installedAt?: Date | null;
    app: AppClient;
  }): Promise<{ ok: true }> {
    await this.prisma.appInstall.createMany({
      data: [
        {
          installationId: input.installationId,
          platform: input.app.platform ?? SessionPlatform.UNKNOWN,
          source: installSource(input.referrer),
          referrer: input.referrer?.slice(0, 500) || null,
          appVersion: input.app.version ?? null,
          installedAt: input.installedAt ?? new Date(),
        },
      ],
      skipDuplicates: true,
    });
    return { ok: true };
  }
}
