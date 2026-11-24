import { Injectable } from '@nestjs/common';
import { AppClient } from '../activity/activity.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { CrashReportDto } from './app-crashes.dto';
import { crashSignature } from './crash-signature';

const MESSAGE_LIMIT = 2_000;
const STACK_LIMIT = 16_000;
// A report from a phone whose clock is off, or kept for weeks: when it arrived instead.
const OLDEST_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Crash reports from the app (docs/features/app-crashes.md): stored with the
 * app version and phone they came from, grouped by signature for the
 * console's Crashes page.
 */
@Injectable()
export class AppCrashesService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    reports: CrashReportDto[],
    client: AppClient,
    userId: string | null,
    now: Date = new Date(),
  ): Promise<{ ok: true; recorded: number }> {
    const rows = reports.map((report) => {
      const message = report.message.trim().slice(0, MESSAGE_LIMIT) || 'No message';
      const stack = report.stack?.trim().slice(0, STACK_LIMIT) || null;
      const at = report.occurredAt ? new Date(report.occurredAt) : now;
      const occurredAt =
        Number.isNaN(at.getTime()) || at > now || now.getTime() - at.getTime() > OLDEST_KEPT_MS
          ? now
          : at;
      return {
        userId,
        kind: report.kind,
        fatal: report.fatal,
        signature: crashSignature(report.kind, message, stack),
        message,
        stack,
        breadcrumbs: (report.breadcrumbs ?? []).map((crumb) => crumb.slice(0, 200)).slice(-30),
        platform: client.platform ?? null,
        appVersion: client.version ?? null,
        appBuild: client.build ?? null,
        deviceModel: report.deviceModel?.trim() || null,
        osVersion: report.osVersion?.trim() || null,
        occurredAt,
      };
    });
    if (rows.length > 0) await this.prisma.appCrash.createMany({ data: rows });
    return { ok: true, recorded: rows.length };
  }
}
