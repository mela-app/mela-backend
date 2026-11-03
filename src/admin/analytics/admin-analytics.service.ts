import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest stretch the Analytics page looks at. */
export const MAX_ANALYTICS_DAYS = 92;

// Retention: the next day, the second week, a month on (days after joining).
const RETURN_WINDOWS = { d1: [1, 1], d7: [7, 13], d30: [30, 36] } as const;
type ReturnWindow = keyof typeof RETURN_WINDOWS;

export interface DayRow {
  day: string;
  newUsers: number;
  activeUsers: number;
  lives: number;
  liveMinutes: number;
  viewerMinutes: number;
  installs: number;
}

export interface CohortRow {
  week: string;
  size: number;
  d1: number;
  d1Eligible: number;
  d7: number;
  d7Eligible: number;
  d30: number;
  d30Eligible: number;
}

/** "YYYY-MM-DD" (UTC) to that day's midnight. */
export function parseDay(day: string): Date {
  const at = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(at.getTime())) {
    throw new BadRequestException(`Not a day: ${day}`);
  }
  return at;
}

const percent = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

/**
 * The console's Analytics page (docs/features/analytics.md): whether Mela
 * grows - accounts and how many come back, lives and watching, the hosts
 * people watch most, where installs come from. Days are UTC. App users only:
 * staff aren't counted.
 */
@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(fromDay: string, toDay: string, now: Date = new Date()) {
    const from = parseDay(fromDay);
    const to = parseDay(toDay);
    if (to < from) throw new BadRequestException('The end of the range is before its start');
    if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_ANALYTICS_DAYS) {
      throw new BadRequestException(`Look at ${MAX_ANALYTICS_DAYS} days at most at a time`);
    }
    const end = new Date(to.getTime() + DAY_MS);
    const [days, active, cohorts, topHosts, installs, users, since] = await Promise.all([
      this.days(from, to),
      this.activeAround(to),
      this.cohorts(to, now),
      this.topHosts(from, end),
      this.prisma.appInstall.groupBy({
        by: ['source'],
        where: { installedAt: { gte: from, lt: end } },
        _count: { _all: true },
      }),
      this.prisma.user.count({ where: { platformRole: PlatformRole.USER } }),
      this.prisma.userActiveDay.aggregate({ _min: { day: true } }),
    ]);
    const sum = (key: keyof Omit<DayRow, 'day'>) =>
      days.reduce((total, row) => total + row[key], 0);
    return {
      from: fromDay,
      to: toDay,
      // Activity is counted from this day on: earlier days show none.
      trackingSince: since._min.day ? since._min.day.toISOString().slice(0, 10) : null,
      totals: {
        users,
        newUsers: sum('newUsers'),
        lives: sum('lives'),
        liveMinutes: sum('liveMinutes'),
        viewerMinutes: sum('viewerMinutes'),
        installs: sum('installs'),
        ...active,
        // How many of the month's users come on a given day.
        stickiness: percent(active.dailyActive, active.monthlyActive),
      },
      days,
      retention: cohorts.map((row) => ({
        week: row.week,
        size: row.size,
        ...Object.fromEntries(
          (Object.keys(RETURN_WINDOWS) as ReturnWindow[]).map((window) => [
            window,
            row[`${window}Eligible`] > 0 ? percent(row[window], row[`${window}Eligible`]) : null,
          ]),
        ),
      })),
      topHosts,
      installSources: installs
        .map((row) => ({ source: row.source, count: row._count._all }))
        .sort((a, b) => b.count - a.count),
    };
  }

  // One row per day, oldest first, zero-filled.
  private days(from: Date, to: Date): Promise<DayRow[]> {
    return this.prisma.$queryRaw<DayRow[]>`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
        (SELECT count(*)::int FROM users u
          WHERE u."createdAt" >= d AND u."createdAt" < d + interval '1 day'
            AND u."platformRole" = 'USER') AS "newUsers",
        (SELECT count(*)::int FROM user_active_days a WHERE a.day = d::date) AS "activeUsers",
        (SELECT count(*)::int FROM streams s
          WHERE s."startedAt" >= d AND s."startedAt" < d + interval '1 day') AS lives,
        (SELECT coalesce(round(sum(extract(epoch FROM (coalesce(s."endedAt", now()) - s."startedAt")) / 60)), 0)::int
          FROM streams s WHERE s."startedAt" >= d AND s."startedAt" < d + interval '1 day') AS "liveMinutes",
        (SELECT coalesce(sum(s."viewerMinutes"), 0)::int FROM streams s
          WHERE s."startedAt" >= d AND s."startedAt" < d + interval '1 day') AS "viewerMinutes",
        (SELECT count(*)::int FROM app_installs i
          WHERE i."installedAt" >= d AND i."installedAt" < d + interval '1 day') AS installs
      FROM generate_series(${from}::timestamp, ${to}::timestamp, interval '1 day') AS d
      ORDER BY d`;
  }

  // Daily, weekly and monthly active users as of [day], and the month's by platform.
  private async activeAround(day: Date) {
    const weekStart = new Date(day.getTime() - 6 * DAY_MS);
    const monthStart = new Date(day.getTime() - 29 * DAY_MS);
    const distinctSince = async (start: Date) =>
      (
        await this.prisma.userActiveDay.groupBy({
          by: ['userId'],
          where: { day: { gte: start, lte: day } },
        })
      ).length;
    const [dailyActive, weeklyActive, monthlyActive, platforms] = await Promise.all([
      this.prisma.userActiveDay.count({ where: { day } }),
      distinctSince(weekStart),
      distinctSince(monthStart),
      this.prisma.$queryRaw<Array<{ platform: string | null; users: number }>>`
        SELECT platform, count(DISTINCT "userId")::int AS users FROM user_active_days
        WHERE day >= ${monthStart}::date AND day <= ${day}::date
        GROUP BY platform`,
    ]);
    return {
      dailyActive,
      weeklyActive,
      monthlyActive,
      monthlyByPlatform: platforms
        .map((row) => ({ platform: row.platform ?? 'UNKNOWN', users: row.users }))
        .sort((a, b) => b.users - a.users),
    };
  }

  // The last 8 weeks' sign-ups (weeks start Monday, UTC), and how many came back.
  private cohorts(to: Date, now: Date): Promise<CohortRow[]> {
    const start = new Date(to.getTime() - 55 * DAY_MS);
    const end = new Date(to.getTime() + DAY_MS);
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const returned = (window: ReturnWindow) => {
      const [first, last] = RETURN_WINDOWS[window];
      return Prisma.sql`EXISTS (SELECT 1 FROM user_active_days a WHERE a."userId" = c.id
        AND a.day BETWEEN c.joined + ${first}::int AND c.joined + ${last}::int)`;
    };
    // Only people whose window has fully passed count towards it.
    const eligible = (window: ReturnWindow) =>
      Prisma.sql`c.joined + ${RETURN_WINDOWS[window][1]}::int < ${today}::date`;
    return this.prisma.$queryRaw<CohortRow[]>`
      WITH c AS (
        SELECT u.id, (u."createdAt" AT TIME ZONE 'UTC')::date AS joined,
          date_trunc('week', u."createdAt" AT TIME ZONE 'UTC')::date AS week
        FROM users u
        WHERE u."createdAt" >= ${start} AND u."createdAt" < ${end} AND u."platformRole" = 'USER'
      )
      SELECT to_char(week, 'YYYY-MM-DD') AS week, count(*)::int AS size,
        count(*) FILTER (WHERE ${eligible('d1')} AND ${returned('d1')})::int AS d1,
        count(*) FILTER (WHERE ${eligible('d1')})::int AS "d1Eligible",
        count(*) FILTER (WHERE ${eligible('d7')} AND ${returned('d7')})::int AS d7,
        count(*) FILTER (WHERE ${eligible('d7')})::int AS "d7Eligible",
        count(*) FILTER (WHERE ${eligible('d30')} AND ${returned('d30')})::int AS d30,
        count(*) FILTER (WHERE ${eligible('d30')})::int AS "d30Eligible"
      FROM c GROUP BY week ORDER BY week DESC`;
  }

  // The hosts watched most in the range, by minutes watched.
  private async topHosts(from: Date, end: Date) {
    const rows = await this.prisma.stream.groupBy({
      by: ['hostId'],
      where: { startedAt: { gte: from, lt: end } },
      _count: { _all: true },
      _sum: { viewerMinutes: true, uniqueViewers: true, likeCount: true },
      _max: { peakViewerCount: true },
      orderBy: [{ _sum: { viewerMinutes: 'desc' } }, { _count: { hostId: 'desc' } }],
      take: 10,
    });
    const hosts = await this.prisma.user.findMany({
      where: { id: { in: rows.map((row) => row.hostId) } },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });
    return rows.flatMap((row) => {
      const host = hosts.find((each) => each.id === row.hostId);
      if (!host) return [];
      return [
        {
          host,
          lives: row._count._all,
          viewerMinutes: row._sum.viewerMinutes ?? 0,
          viewers: row._sum.uniqueViewers ?? 0,
          likes: row._sum.likeCount ?? 0,
          peakViewers: row._max.peakViewerCount ?? 0,
        },
      ];
    });
  }
}
