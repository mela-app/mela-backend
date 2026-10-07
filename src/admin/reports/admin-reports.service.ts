import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, ReportCaseStatus, ReportReason, ReportTargetType } from '@prisma/client';
import { pageArgs, toPage } from '../../common/pagination/page-query.dto';
import { DomainEvents, ReportCaseResolvedPayload } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DirectMessagesService } from '../../direct-messages/direct-messages.service';
import { AdminPrincipal } from '../admin.guard';
import { AdminReportsQueryDto } from './admin-reports.dto';

const PERSON = {
  select: { id: true, username: true, displayName: true, avatarUrl: true, status: true },
} as const;

const CASE_SELECT = {
  id: true,
  targetType: true,
  targetId: true,
  streamId: true,
  snapshot: true,
  status: true,
  urgent: true,
  reportCount: true,
  lastReportedAt: true,
  createdAt: true,
  resolvedAt: true,
  resolutionNote: true,
  reportedUser: PERSON,
  resolvedBy: PERSON,
} satisfies Prisma.ReportCaseSelect;

type CaseRow = Prisma.ReportCaseGetPayload<{ select: typeof CASE_SELECT }>;

interface SnapshotPerson {
  username?: string;
}

/** How a case reads in a list or the audit log, e.g. "Chat message from @ana". */
export function caseLabel(targetType: ReportTargetType, snapshot: Prisma.JsonValue): string {
  const shown = (snapshot ?? {}) as { person?: SnapshotPerson; title?: string };
  const who = shown.person?.username ? `@${shown.person.username}` : 'a deleted account';
  switch (targetType) {
    case ReportTargetType.LIVE:
      return `Live "${shown.title ?? 'Untitled'}" by ${who}`;
    case ReportTargetType.CHAT_MESSAGE:
      return `Chat message from ${who}`;
    case ReportTargetType.USER:
      return `Profile of ${who}`;
    case ReportTargetType.DIRECT_MESSAGE:
      return `Private message from ${who}`;
  }
}

/**
 * The console's Reports page (docs/features/moderation.md): what users
 * reported, one case per reported thing, the urgent and most recent first;
 * then a decision - acted on, or no violation - that each reporter hears
 * about. Removing content, locking a live or suspending someone are the
 * console's usual actions, with their own permissions; a reported private
 * message can only be erased from here.
 */
@Injectable()
export class AdminReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directMessages: DirectMessagesService,
    private readonly events: EventEmitter2,
  ) {}

  async list(query: AdminReportsQueryDto) {
    const where = {
      status: query.status,
      ...(query.type && { targetType: query.type }),
    } satisfies Prisma.ReportCaseWhereInput;
    const orderBy: Prisma.ReportCaseOrderByWithRelationInput[] =
      query.status === ReportCaseStatus.OPEN
        ? [{ urgent: 'desc' }, { lastReportedAt: 'desc' }]
        : [{ resolvedAt: 'desc' }];
    const [rows, total] = await Promise.all([
      this.prisma.reportCase.findMany({ where, orderBy, ...pageArgs(query), select: CASE_SELECT }),
      this.prisma.reportCase.count({ where }),
    ]);
    const reasons = await this.reasonsOf(rows.map((row) => row.id));
    return toPage(
      rows.map((row) => this.view(row, reasons.get(row.id) ?? [])),
      total,
      query,
    );
  }

  async detail(caseId: string) {
    const row = await this.prisma.reportCase.findUnique({
      where: { id: caseId },
      select: {
        ...CASE_SELECT,
        reports: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, reason: true, details: true, createdAt: true, reporter: PERSON },
        },
      },
    });
    if (!row) throw new NotFoundException('Report not found');
    const [reasons, targetExists, live, otherCases] = await Promise.all([
      this.reasonsOf([row.id]),
      this.targetExists(row.targetType, row.targetId),
      row.streamId
        ? this.prisma.stream.findUnique({
            where: { id: row.streamId },
            select: { id: true, title: true, status: true },
          })
        : null,
      row.reportedUser
        ? this.prisma.reportCase.count({
            where: { reportedUserId: row.reportedUser.id, id: { not: row.id } },
          })
        : 0,
    ]);
    const { reports, ...rest } = row;
    return {
      ...this.view(rest, reasons.get(row.id) ?? []),
      reports,
      // Erased, removed or deleted since it was reported.
      targetExists,
      live,
      // Earlier and later cases about the same account.
      otherCases,
    };
  }

  async resolve(
    admin: AdminPrincipal,
    caseId: string,
    outcome: 'ACTIONED' | 'DISMISSED',
    note: string | undefined,
  ) {
    const found = await this.prisma.reportCase.findUnique({
      where: { id: caseId },
      select: {
        status: true,
        targetType: true,
        snapshot: true,
        reports: { select: { reporterId: true } },
      },
    });
    if (!found) throw new NotFoundException('Report not found');
    const trimmed = note?.trim() || null;
    const { count } = await this.prisma.reportCase.updateMany({
      where: { id: caseId, status: ReportCaseStatus.OPEN },
      data: {
        status: outcome,
        resolvedById: admin.id,
        resolvedAt: new Date(),
        resolutionNote: trimmed,
      },
    });
    if (count === 0) throw new ConflictException('This report was already decided');
    this.events.emit(DomainEvents.ReportCaseResolved, {
      caseId,
      outcome,
      actorId: admin.id,
      targetType: found.targetType,
      label: caseLabel(found.targetType, found.snapshot),
      reporterIds: [...new Set(found.reports.flatMap((report) => report.reporterId ?? []))],
      note: trimmed,
    } satisfies ReportCaseResolvedPayload);
    return this.detail(caseId);
  }

  /** Erases the reported private message for both people; the case keeps what it said. */
  async removeMessage(admin: AdminPrincipal, caseId: string) {
    const found = await this.prisma.reportCase.findUnique({
      where: { id: caseId },
      select: { targetType: true, targetId: true },
    });
    if (!found) throw new NotFoundException('Report not found');
    if (found.targetType !== ReportTargetType.DIRECT_MESSAGE) {
      throw new BadRequestException('Only a reported private message is removed here');
    }
    return { removed: await this.directMessages.erase(found.targetId, admin.id) };
  }

  private view(row: CaseRow, reasons: Array<{ reason: ReportReason; count: number }>) {
    return { ...row, label: caseLabel(row.targetType, row.snapshot), reasons };
  }

  // Why it was reported, most often first.
  private async reasonsOf(caseIds: string[]) {
    const byCase = new Map<string, Array<{ reason: ReportReason; count: number }>>();
    if (caseIds.length === 0) return byCase;
    const groups = await this.prisma.report.groupBy({
      by: ['caseId', 'reason'],
      where: { caseId: { in: caseIds } },
      _count: { _all: true },
    });
    for (const group of groups) {
      const reasons = byCase.get(group.caseId) ?? [];
      reasons.push({ reason: group.reason, count: group._count._all });
      byCase.set(group.caseId, reasons);
    }
    for (const reasons of byCase.values()) reasons.sort((a, b) => b.count - a.count);
    return byCase;
  }

  private async targetExists(type: ReportTargetType, id: string): Promise<boolean> {
    const where = { where: { id }, select: { id: true } };
    switch (type) {
      case ReportTargetType.LIVE:
        return (await this.prisma.stream.findUnique(where)) !== null;
      case ReportTargetType.CHAT_MESSAGE:
        return (await this.prisma.chatMessage.findUnique(where)) !== null;
      case ReportTargetType.USER:
        return (await this.prisma.user.findUnique(where)) !== null;
      case ReportTargetType.DIRECT_MESSAGE:
        return (await this.prisma.directMessage.findUnique(where)) !== null;
    }
  }
}
