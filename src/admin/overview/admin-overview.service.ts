import { Injectable } from '@nestjs/common';
import { AdminPermission, StreamStatus, UserStatus } from '@prisma/client';
import { LivePresenceService } from '../../common/presence/live-presence.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminPrincipal } from '../admin.guard';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyRow {
  day: string;
  streams: number;
  signups: number;
}

/** The console's home (plan §6.8): what's happening now, and the last two weeks at a glance. */
@Injectable()
export class AdminOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: LivePresenceService,
  ) {}

  /** Totals for every staff member; which lives they are only for those who may see them. */
  async overview(admin: AdminPrincipal) {
    const since = new Date(Date.now() - DAY_MS);
    const lives = await this.prisma.stream.findMany({
      where: { status: StreamStatus.LIVE },
      orderBy: { startedAt: 'desc' },
      take: 200,
      select: {
        id: true,
        title: true,
        category: true,
        startedAt: true,
        host: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    const [
      viewerCounts,
      users,
      newUsers,
      suspendedUsers,
      messages,
      streamsStarted,
      alertsSent,
      daily,
    ] = await Promise.all([
      this.presence
        .viewerCounts(lives.map((live) => live.id))
        .catch(() => new Map<string, number>()),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: since } } }),
      this.prisma.user.count({ where: { status: UserStatus.SUSPENDED } }),
      this.prisma.chatMessage.count({ where: { createdAt: { gte: since } } }),
      this.prisma.stream.count({ where: { startedAt: { gte: since } } }),
      this.prisma.adminAlert.count({ where: { createdAt: { gte: since } } }),
      this.dailySeries(),
    ]);

    const liveNow = lives
      .map((live) => ({ ...live, viewerCount: viewerCounts.get(live.id) ?? 0 }))
      .sort((a, b) => b.viewerCount - a.viewerCount);
    return {
      generatedAt: new Date(),
      live: {
        streams: lives.length,
        viewers: liveNow.reduce((sum, live) => sum + live.viewerCount, 0),
        top: admin.permissions.includes(AdminPermission.VIEW_LIVES) ? liveNow.slice(0, 5) : [],
      },
      users: { total: users, new24h: newUsers, suspended: suspendedUsers },
      activity24h: { messages, streamsStarted, alertsSent },
      daily,
    };
  }

  // The last 14 whole UTC days, oldest first, zero-filled, so the chart never has gaps.
  private async dailySeries(): Promise<DailyRow[]> {
    const rows = await this.prisma.$queryRaw<DailyRow[]>`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
        (SELECT count(*)::int FROM streams s WHERE s."startedAt" >= d AND s."startedAt" < d + interval '1 day') AS streams,
        (SELECT count(*)::int FROM users u WHERE u."createdAt" >= d AND u."createdAt" < d + interval '1 day') AS signups
      FROM generate_series(
        date_trunc('day', now() AT TIME ZONE 'UTC') - interval '13 days',
        date_trunc('day', now() AT TIME ZONE 'UTC'),
        interval '1 day'
      ) AS d
      ORDER BY d`;
    return rows;
  }
}
