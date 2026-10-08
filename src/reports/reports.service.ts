import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ReportCaseStatus, ReportReason, ReportTargetType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimit, RateLimitService } from '../common/rate-limit/rate-limit.service';
import { SocialService } from '../social/social.service';
import { CreateReportDto } from './dto/create-report.dto';

/** Ten at once, then one every six minutes, per person - room for real reports, not a flood. */
export const REPORT_RATE_LIMIT: RateLimit = { capacity: 10, refillMs: 6 * 60_000 };

/** Reviewed before anything else. */
export const URGENT_REASONS: ReadonlySet<ReportReason> = new Set([
  ReportReason.CHILD_SAFETY,
  ReportReason.SELF_HARM,
]);

const PERSON = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

interface ReportedThing {
  reportedUserId: string;
  streamId: string | null;
  snapshot: Prisma.InputJsonObject;
}

/**
 * Reporting a live, a chat message, an account or a private message
 * (docs/features/moderation.md) - what app stores require of apps where
 * people share things. Each report joins the open case about the same
 * thing, if there is one, so staff decide on it once; what it showed is
 * kept with the case, in case it's deleted meanwhile.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly social: SocialService,
  ) {}

  async submit(reporterId: string, dto: CreateReportDto): Promise<{ ok: true }> {
    const details = dto.details?.trim() || null;
    if (dto.reason === ReportReason.OTHER && !details) {
      throw new BadRequestException({ message: "Tell us what's wrong.", code: 'DETAILS_REQUIRED' });
    }
    if ((await this.rateLimit.take(`report:${reporterId}`, REPORT_RATE_LIMIT)) > 0) {
      throw new HttpException(
        {
          message: "You've sent a lot of reports. Try again in a little while.",
          code: 'RATE_LIMITED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const thing = await this.describe(dto.targetType, dto.targetId, reporterId);
    if (thing.reportedUserId === reporterId) {
      throw new BadRequestException({
        message: "You can't report yourself.",
        code: 'CANNOT_REPORT_SELF',
      });
    }

    const urgent = URGENT_REASONS.has(dto.reason);
    await this.prisma.$transaction(async (tx) => {
      // One case per thing at a time, even when several people report it at once.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`report:${dto.targetType}:${dto.targetId}`}))`;
      const open = await tx.reportCase.findFirst({
        where: {
          targetType: dto.targetType,
          targetId: dto.targetId,
          status: ReportCaseStatus.OPEN,
        },
        select: { id: true },
      });
      if (!open) {
        await tx.reportCase.create({
          data: {
            targetType: dto.targetType,
            targetId: dto.targetId,
            reportedUserId: thing.reportedUserId,
            streamId: thing.streamId,
            snapshot: thing.snapshot,
            urgent,
            reports: { create: { reporterId, reason: dto.reason, details } },
          },
        });
        return;
      }
      const already = await tx.report.findUnique({
        where: { caseId_reporterId: { caseId: open.id, reporterId } },
        select: { id: true },
      });
      // Reporting it again adds nothing staff don't already have.
      if (already) return;
      await tx.report.create({
        data: { caseId: open.id, reporterId, reason: dto.reason, details },
      });
      await tx.reportCase.update({
        where: { id: open.id },
        data: {
          reportCount: { increment: 1 },
          lastReportedAt: new Date(),
          ...(urgent && { urgent: true }),
        },
      });
    });

    if (dto.block) {
      await this.social.block(reporterId, thing.reportedUserId);
    }
    return { ok: true };
  }

  /** Whose it is, and what it shows now - checked to be something this person may report. */
  private async describe(
    type: ReportTargetType,
    id: string,
    reporterId: string,
  ): Promise<ReportedThing> {
    switch (type) {
      case ReportTargetType.LIVE: {
        const live = await this.prisma.stream.findUnique({
          where: { id },
          select: { title: true, category: true, startedAt: true, host: PERSON },
        });
        if (!live) throw new NotFoundException('That live is no longer available');
        return {
          reportedUserId: live.host.id,
          streamId: id,
          snapshot: {
            title: live.title,
            category: live.category,
            startedAt: live.startedAt?.toISOString() ?? null,
            person: live.host,
          },
        };
      }
      case ReportTargetType.CHAT_MESSAGE: {
        const message = await this.prisma.chatMessage.findUnique({
          where: { id },
          select: {
            text: true,
            imageUrl: true,
            createdAt: true,
            streamId: true,
            user: PERSON,
            stream: { select: { title: true } },
          },
        });
        if (!message) throw new NotFoundException('That message is no longer available');
        return {
          reportedUserId: message.user.id,
          streamId: message.streamId,
          snapshot: {
            text: message.text,
            imageUrl: message.imageUrl,
            sentAt: message.createdAt.toISOString(),
            liveTitle: message.stream.title,
            person: message.user,
          },
        };
      }
      case ReportTargetType.USER: {
        const user = await this.prisma.user.findUnique({
          where: { id },
          select: { id: true, username: true, displayName: true, avatarUrl: true, bio: true },
        });
        if (!user) throw new NotFoundException('That account is no longer available');
        const { bio, ...person } = user;
        return { reportedUserId: user.id, streamId: null, snapshot: { bio, person } };
      }
      case ReportTargetType.DIRECT_MESSAGE: {
        const message = await this.prisma.directMessage.findUnique({
          where: { id },
          select: { text: true, createdAt: true, recipientId: true, sender: PERSON },
        });
        // Only the person it was sent to can report it; to anyone else it doesn't exist.
        if (!message || message.recipientId !== reporterId) {
          throw new NotFoundException('That message is no longer available');
        }
        return {
          reportedUserId: message.sender.id,
          streamId: null,
          snapshot: {
            text: message.text,
            sentAt: message.createdAt.toISOString(),
            person: message.sender,
          },
        };
      }
    }
  }
}
