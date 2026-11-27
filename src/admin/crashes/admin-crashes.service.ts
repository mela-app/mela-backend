import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppCrashKind, Prisma } from '@prisma/client';
import { ActivityRecordedPayload, DomainEvents } from '../../common/events/domain-events';
import { AdminPrincipal } from '../admin.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { pageArgs, toPage } from '../../common/pagination/page-query.dto';
import {
  CrashExportQueryDto,
  CrashGroupsQueryDto,
  CrashReportsQueryDto,
} from './admin-crashes.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
// An export: the most common crashes, each with its newest reports - enough to
// see what's wrong without a file too big to hand on.
const EXPORT_GROUPS = 50;
const EXPORT_REPORTS_PER_GROUP = 5;

/** One crash as it happens on many phones: the latest report's words, and how far it reaches. */
export interface CrashGroup {
  signature: string;
  kind: AppCrashKind;
  fatal: boolean;
  message: string;
  count: number;
  // Signed-in people it happened to; signed-out reports aren't counted here.
  users: number;
  firstSeen: Date;
  lastSeen: Date;
  versions: string[];
  devices: string[];
}

export interface DayCount {
  day: string;
  fatal: number;
  errors: number;
}

/**
 * The console's Crashes page (docs/features/app-crashes.md): what's going
 * wrong in the app, grouped so the most common crash comes first, with each
 * report's stack, phone and the steps that led to it.
 */
@Injectable()
export class AdminCrashesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async groups(query: CrashGroupsQueryDto, now: Date = new Date()) {
    const since = new Date(now.getTime() - query.days * DAY_MS);
    const where = Prisma.sql`WHERE "occurredAt" >= ${since}
      ${query.kind ? Prisma.sql`AND kind = ${query.kind}::"AppCrashKind"` : Prisma.empty}
      ${query.appVersion ? Prisma.sql`AND "appVersion" = ${query.appVersion}` : Prisma.empty}
      ${query.fatal ? Prisma.sql`AND fatal = true` : Prisma.empty}`;
    const { skip, take } = pageArgs(query);
    const [rows, totals, days, versions] = await Promise.all([
      this.prisma.$queryRaw<CrashGroup[]>`
        SELECT signature,
          count(*)::int AS count,
          count(DISTINCT "userId")::int AS users,
          min("occurredAt") AS "firstSeen",
          max("occurredAt") AS "lastSeen",
          (array_agg(kind ORDER BY "occurredAt" DESC))[1] AS kind,
          (array_agg(fatal ORDER BY "occurredAt" DESC))[1] AS fatal,
          (array_agg(message ORDER BY "occurredAt" DESC))[1] AS message,
          coalesce(array_agg(DISTINCT "appVersion") FILTER (WHERE "appVersion" IS NOT NULL), '{}') AS versions,
          coalesce((array_agg(DISTINCT "deviceModel") FILTER (WHERE "deviceModel" IS NOT NULL))[1:5], '{}') AS devices
        FROM app_crashes ${where}
        GROUP BY signature
        ORDER BY count DESC, max("occurredAt") DESC
        LIMIT ${take} OFFSET ${skip}`,
      this.prisma.$queryRaw<
        Array<{ groups: number; reports: number; fatal: number; users: number }>
      >`
        SELECT count(DISTINCT signature)::int AS groups, count(*)::int AS reports,
          count(*) FILTER (WHERE fatal)::int AS fatal, count(DISTINCT "userId")::int AS users
        FROM app_crashes ${where}`,
      this.days(since, now),
      this.prisma.appCrash.findMany({
        where: { occurredAt: { gte: since }, appVersion: { not: null } },
        distinct: ['appVersion'],
        select: { appVersion: true },
      }),
    ]);
    const total = totals[0] ?? { groups: 0, reports: 0, fatal: 0, users: 0 };
    return {
      ...toPage(rows, total.groups, query),
      totals: { reports: total.reports, fatal: total.fatal, users: total.users },
      days,
      versions: versions.flatMap((row) => row.appVersion ?? []).sort(compareVersionsDesc),
    };
  }

  /** One crash's reports, newest first: the full stack, the phone, who, and what they did just before. */
  async reports(signature: string, query: CrashReportsQueryDto, now: Date = new Date()) {
    const where = {
      signature,
      occurredAt: { gte: new Date(now.getTime() - query.days * DAY_MS) },
    } satisfies Prisma.AppCrashWhereInput;
    const [rows, total] = await Promise.all([
      this.prisma.appCrash.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        ...pageArgs(query),
        select: {
          id: true,
          kind: true,
          fatal: true,
          message: true,
          stack: true,
          breadcrumbs: true,
          platform: true,
          appVersion: true,
          appBuild: true,
          deviceModel: true,
          osVersion: true,
          occurredAt: true,
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
      }),
      this.prisma.appCrash.count({ where }),
    ]);
    if (total === 0) throw new NotFoundException('No reports of this crash in that time');
    return toPage(rows, total, query);
  }

  /**
   * Removes a crash: every report of it, however old (fixed, or noise). If it
   * happens again it comes back as new.
   */
  async removeCrash(admin: AdminPrincipal, signature: string) {
    const latest = await this.prisma.appCrash.findFirst({
      where: { signature },
      orderBy: { occurredAt: 'desc' },
      select: { kind: true, message: true },
    });
    if (!latest) throw new NotFoundException('That crash has no reports');
    const { count } = await this.prisma.appCrash.deleteMany({ where: { signature } });
    this.events.emit(DomainEvents.ActivityRecorded, {
      action: 'crash.deleted',
      actorId: admin.id,
      metadata: {
        signature,
        kind: latest.kind,
        message: latest.message.slice(0, 200),
        removed: count,
      },
    } satisfies ActivityRecordedPayload);
    return { removed: count };
  }

  /** Removes one report of a crash. */
  async removeReport(admin: AdminPrincipal, reportId: string) {
    const report = await this.prisma.appCrash.findUnique({
      where: { id: reportId },
      select: { signature: true, kind: true },
    });
    if (!report) throw new NotFoundException('Crash report not found');
    await this.prisma.appCrash.deleteMany({ where: { id: reportId } });
    this.events.emit(DomainEvents.ActivityRecorded, {
      action: 'crash.report_deleted',
      actorId: admin.id,
      metadata: { reportId, signature: report.signature, kind: report.kind },
    } satisfies ActivityRecordedPayload);
    return { removed: 1 };
  }

  /**
   * Crashes to hand to whoever fixes them (docs/features/app-crashes.md,
   * "Exporting"): the most common first, each with its newest reports' stack,
   * breadcrumbs, phone and app version - and nobody's account: a report says
   * only whether someone was signed in. Recorded in the audit log.
   */
  async export(admin: AdminPrincipal, query: CrashExportQueryDto, now: Date = new Date()) {
    const since = new Date(now.getTime() - query.days * DAY_MS);
    const page = await this.groups(
      Object.assign(new CrashGroupsQueryDto(), {
        days: query.days,
        kind: query.kind,
        appVersion: query.appVersion,
        fatal: query.fatal,
        page: 1,
        pageSize: 100,
      }),
      now,
    );
    const chosen = (
      query.signature
        ? page.items.filter((group) => group.signature === query.signature)
        : page.items
    ).slice(0, EXPORT_GROUPS);
    const groups = await Promise.all(
      chosen.map(async (group) => ({
        ...group,
        reports: await this.prisma.appCrash.findMany({
          where: {
            signature: group.signature,
            occurredAt: { gte: since },
            ...(query.appVersion && { appVersion: query.appVersion }),
          },
          orderBy: { occurredAt: 'desc' },
          take: EXPORT_REPORTS_PER_GROUP,
          select: {
            id: true,
            kind: true,
            fatal: true,
            message: true,
            stack: true,
            breadcrumbs: true,
            platform: true,
            appVersion: true,
            appBuild: true,
            deviceModel: true,
            osVersion: true,
            occurredAt: true,
            userId: true,
          },
        }),
      })),
    );
    this.events.emit(DomainEvents.ActivityRecorded, {
      action: 'crash.exported',
      actorId: admin.id,
      metadata: {
        days: query.days,
        kind: query.kind ?? null,
        appVersion: query.appVersion ?? null,
        fatal: query.fatal ?? false,
        signature: query.signature ?? null,
        crashes: groups.length,
      },
    } satisfies ActivityRecordedPayload);
    return {
      generatedAt: now,
      filters: {
        days: query.days,
        kind: query.kind ?? null,
        appVersion: query.appVersion ?? null,
        fatal: query.fatal ?? false,
        signature: query.signature ?? null,
      },
      totals: { ...page.totals, crashes: page.total },
      groups: groups.map(({ reports, ...group }) => ({
        ...group,
        reports: reports.map(({ userId, ...report }) => ({ ...report, signedIn: userId !== null })),
      })),
    };
  }

  // Each day's fatal crashes and other errors, oldest first, zero-filled.
  private days(since: Date, now: Date): Promise<DayCount[]> {
    return this.prisma.$queryRaw<DayCount[]>`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
        count(c.id) FILTER (WHERE c.fatal)::int AS fatal,
        count(c.id) FILTER (WHERE NOT c.fatal)::int AS errors
      FROM generate_series(date_trunc('day', ${since}::timestamp), date_trunc('day', ${now}::timestamp), interval '1 day') AS d
      LEFT JOIN app_crashes c ON c."occurredAt" >= d AND c."occurredAt" < d + interval '1 day'
      GROUP BY d ORDER BY d`;
  }
}

function compareVersionsDesc(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (right[i] ?? 0) - (left[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
