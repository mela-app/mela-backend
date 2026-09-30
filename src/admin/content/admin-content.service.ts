import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminPermission, AlertScope, BannedPhraseSeverity, Prisma, StreamStatus } from '@prisma/client';
import { BannedPhrasesService } from '../../chat/banned-phrases.service';
import { AdminAlertSentPayload, BannedPhraseChangedPayload, DomainEvents } from '../../common/events/domain-events';
import { PageQueryDto, pageArgs, toPage } from '../../common/pagination/page-query.dto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { AdminPrincipal } from '../admin.guard';
import { BannedPhraseDto, SendAlertDto, UpdateBannedPhraseDto } from './admin-content.dto';

const PERSON_SELECT = { select: { id: true, username: true, displayName: true } } as const;

/**
 * What the admin console says to the app, and what it lets through: in-app
 * alerts (plan §6.8) and the banned-phrase list the chat filter reads
 * (plan §6.3). Who may do which is decided per permission by the routes;
 * alerting everyone also needs SEND_GLOBAL_ALERTS.
 */
@Injectable()
export class AdminContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly bannedPhrases: BannedPhrasesService,
    private readonly events: EventEmitter2,
  ) {}

  async listAlerts(query: PageQueryDto) {
    const [rows, total] = await Promise.all([
      this.prisma.adminAlert.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          scope: true,
          message: true,
          severity: true,
          recipientCount: true,
          createdAt: true,
          createdBy: PERSON_SELECT,
          stream: { select: { id: true, title: true, status: true } },
        },
        ...pageArgs(query),
      }),
      this.prisma.adminAlert.count(),
    ]);
    return toPage(rows, total, query);
  }

  /** Running lives an alert can go to, newest first, with how many devices each would reach now. */
  async alertTargets() {
    const lives = await this.prisma.stream.findMany({
      where: { status: StreamStatus.LIVE },
      orderBy: { startedAt: 'desc' },
      take: 100,
      select: { id: true, title: true, host: PERSON_SELECT },
    });
    return { items: lives.map((live) => ({ ...live, reach: this.realtime.connectedCount(live.id) })) };
  }

  async sendAlert(admin: AdminPrincipal, dto: SendAlertDto) {
    if (dto.scope === AlertScope.GLOBAL && !admin.permissions.includes(AdminPermission.SEND_GLOBAL_ALERTS)) {
      throw new ForbiddenException({
        message: "You can't alert everyone. A super admin can give you access.",
        code: 'MISSING_PERMISSION',
      });
    }
    const streamId = dto.scope === AlertScope.STREAM ? (dto.streamId ?? null) : null;
    if (streamId) {
      const stream = await this.prisma.stream.findUnique({ where: { id: streamId }, select: { status: true } });
      if (!stream) throw new NotFoundException('Stream not found');
      if (stream.status !== StreamStatus.LIVE) throw new ConflictException('That live has ended');
    }

    const alert = await this.prisma.adminAlert.create({
      data: {
        scope: dto.scope,
        streamId,
        message: dto.message,
        severity: dto.severity,
        createdById: admin.id,
        recipientCount: this.realtime.connectedCount(streamId ?? undefined),
      },
    });
    this.events.emit(DomainEvents.AdminAlertSent, {
      alertId: alert.id,
      actorId: admin.id,
      scope: alert.scope,
      streamId: alert.streamId,
      message: alert.message,
      severity: alert.severity,
      createdAt: alert.createdAt,
    } satisfies AdminAlertSentPayload);
    return alert;
  }

  async listPhrases(q?: string, severity?: BannedPhraseSeverity) {
    const needle = q?.trim();
    const items = await this.prisma.bannedPhrase.findMany({
      where: {
        ...(needle ? { phrase: { contains: needle, mode: 'insensitive' } } : {}),
        ...(severity ? { severity } : {}),
      },
      orderBy: { phrase: 'asc' },
      select: { id: true, phrase: true, severity: true, createdAt: true, creator: PERSON_SELECT },
    });
    return { items };
  }

  async addPhrase(admin: AdminPrincipal, dto: BannedPhraseDto) {
    try {
      const phrase = await this.prisma.bannedPhrase.create({
        data: { phrase: dto.phrase, severity: dto.severity, createdBy: admin.id },
      });
      this.announcePhrase(DomainEvents.BannedPhraseCreated, admin, phrase);
      return phrase;
    } catch (error) {
      throw duplicateOr(error);
    }
  }

  async updatePhrase(admin: AdminPrincipal, phraseId: string, dto: UpdateBannedPhraseDto) {
    await this.getPhrase(phraseId);
    try {
      const phrase = await this.prisma.bannedPhrase.update({
        where: { id: phraseId },
        data: { ...(dto.phrase ? { phrase: dto.phrase } : {}), ...(dto.severity ? { severity: dto.severity } : {}) },
      });
      this.announcePhrase(DomainEvents.BannedPhraseUpdated, admin, phrase);
      return phrase;
    } catch (error) {
      throw duplicateOr(error);
    }
  }

  async removePhrase(admin: AdminPrincipal, phraseId: string) {
    const phrase = await this.getPhrase(phraseId);
    await this.prisma.bannedPhrase.delete({ where: { id: phraseId } });
    this.announcePhrase(DomainEvents.BannedPhraseDeleted, admin, phrase);
    return { ok: true };
  }

  /** What the live filter would do with [text], using the list as it is now. */
  async testPhrase(text: string) {
    this.bannedPhrases.invalidate();
    const matches = await this.bannedPhrases.match(text);
    const rejected = matches.some((match) => match.severity === BannedPhraseSeverity.REJECT);
    return {
      matches,
      outcome: rejected ? 'REJECTED' : matches.length > 0 ? 'MASKED' : 'ALLOWED',
      delivered: rejected ? null : await this.bannedPhrases.mask(text),
    };
  }

  private async getPhrase(phraseId: string) {
    const phrase = await this.prisma.bannedPhrase.findUnique({ where: { id: phraseId } });
    if (!phrase) throw new NotFoundException('Phrase not found');
    return phrase;
  }

  private announcePhrase(
    event: typeof DomainEvents.BannedPhraseCreated | typeof DomainEvents.BannedPhraseUpdated | typeof DomainEvents.BannedPhraseDeleted,
    admin: AdminPrincipal,
    phrase: { id: string; phrase: string; severity: BannedPhraseSeverity },
  ): void {
    this.events.emit(event, {
      phraseId: phrase.id,
      actorId: admin.id,
      phrase: phrase.phrase,
      severity: phrase.severity,
    } satisfies BannedPhraseChangedPayload);
  }
}

function duplicateOr(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException('That phrase is already on the list');
  }
  return error;
}
