import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HostingAppealState, Prisma } from '@prisma/client';
import {
  DomainEvents,
  HostingAppealAnsweredPayload,
  HostingAppealSentPayload,
  HostingReasonSavedPayload,
  HostingRestrictedPayload,
  HostingRestrictionChangedPayload,
  HostingRestrictionLiftedPayload,
} from '../common/events/domain-events';
import { pageArgs, PageQueryDto, toPage } from '../common/pagination/page-query.dto';
import { PrismaService } from '../common/prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../common/storage/storage-provider.interface';
import {
  activeRestrictionWhere,
  APPEAL_MAX_IMAGES,
  APPEAL_TEXT_MAX,
  appealImageKey,
  AppealImageType,
  appealOpensAt,
  isAppealImageKey,
  restrictionStatus,
} from './hosting-rules';

const PERSON = { id: true, username: true, displayName: true, avatarUrl: true } as const;

const MESSAGE_SELECT = {
  id: true,
  fromStaff: true,
  text: true,
  imageUrls: true,
  createdAt: true,
  author: { select: PERSON },
} as const;

const SUMMARY_SELECT = {
  id: true,
  title: true,
  message: true,
  note: true,
  endsAt: true,
  liftedAt: true,
  appealState: true,
  keptAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: PERSON },
  stream: { select: { id: true, title: true, startedAt: true, status: true } },
  createdBy: { select: PERSON },
  liftedBy: { select: PERSON },
  _count: { select: { messages: true } },
} as const;

type SummaryRow = Prisma.HostingRestrictionGetPayload<{ select: typeof SUMMARY_SELECT }>;

/** Which of them a staff list shows. */
export type RestrictionFilter = 'waiting' | 'active' | 'ended' | 'all';

export interface StaffActor {
  id: string;
}

/**
 * Pausing someone's hosting (docs/features/hosting-restrictions.md): staff
 * restrict a host because of a live - with a reason they wrote, now or
 * before - until they lift it or the time they set runs out. Meanwhile the
 * host can't go live, join a stage or schedule a live; everything else in
 * the app stays as it is. The host may appeal, with pictures; the team
 * answers, keeps it or lifts it - all of it shown on that live's page.
 */
@Injectable()
export class HostingRestrictionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // --- Whether someone may host ------------------------------------------

  /** The restriction in force on [userId], if any. */
  active(userId: string, now: Date = new Date()) {
    return this.prisma.hostingRestriction.findFirst({
      where: { userId, ...activeRestrictionWhere(now) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, endsAt: true, streamId: true },
    });
  }

  /** Refuses going live, a stage or a scheduled live while [userId]'s hosting is paused. */
  async assertCanHost(userId: string, now: Date = new Date()): Promise<void> {
    if (await this.active(userId, now)) {
      throw new ForbiddenException({
        message: 'Hosting is paused on your account. You can still watch and chat.',
        code: 'HOSTING_RESTRICTED',
      });
    }
  }

  async isRestricted(userId: string, now: Date = new Date()): Promise<boolean> {
    return (await this.active(userId, now)) !== null;
  }

  // --- The host's own side (the app) -----------------------------------------

  /** What the app shows a restricted host: the reason, until when, and the conversation. */
  async mine(userId: string, now: Date = new Date()) {
    const row = await this.prisma.hostingRestriction.findFirst({
      where: { userId, ...activeRestrictionWhere(now) },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        message: true,
        endsAt: true,
        appealState: true,
        keptAt: true,
        createdAt: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, fromStaff: true, text: true, imageUrls: true, createdAt: true },
        },
      },
    });
    if (!row) return { restriction: null };
    const opensAt = appealOpensAt(row, now);
    return {
      restriction: {
        id: row.id,
        title: row.title,
        message: row.message,
        since: row.createdAt,
        endsAt: row.endsAt,
        appealState: row.appealState,
        canWrite: opensAt !== null && opensAt.getTime() <= now.getTime(),
        writeOpensAt: opensAt,
        messages: row.messages,
      },
    };
  }

  /** A presigned upload for one picture the host is about to send with an appeal. */
  async appealImageUploadUrl(userId: string, contentType: AppealImageType, now: Date = new Date()) {
    const restriction = await this.active(userId, now);
    if (!restriction) throw new NotFoundException('Your hosting is not paused');
    const imageKey = appealImageKey(restriction.id, contentType);
    return { ...(await this.storage.createUploadUrl(imageKey, contentType)), imageKey };
  }

  /** The host writes to the team - an appeal, or what the team asked for. */
  async appeal(
    userId: string,
    input: { text: string; imageKeys?: string[] },
    now: Date = new Date(),
  ) {
    const row = await this.prisma.hostingRestriction.findFirst({
      where: { userId, ...activeRestrictionWhere(now) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, streamId: true, appealState: true, keptAt: true },
    });
    if (!row) throw new NotFoundException('Your hosting is not paused');
    const opensAt = appealOpensAt(row, now);
    if (opensAt === null) {
      throw new ConflictException({
        message: 'The Mela team is still reviewing what you sent.',
        code: 'APPEAL_PENDING',
      });
    }
    if (opensAt.getTime() > now.getTime()) {
      throw new ConflictException({
        message: 'You can write again a day after the team answered.',
        code: 'APPEAL_TOO_SOON',
        opensAt: opensAt.toISOString(),
      });
    }
    const text = input.text.trim();
    if (text.length === 0 || text.length > APPEAL_TEXT_MAX) {
      throw new BadRequestException(`Write your message - at most ${APPEAL_TEXT_MAX} characters`);
    }
    const keys = [...new Set(input.imageKeys ?? [])];
    if (keys.length > APPEAL_MAX_IMAGES) {
      throw new BadRequestException(`At most ${APPEAL_MAX_IMAGES} pictures`);
    }
    if (keys.some((key) => !isAppealImageKey(key, row.id))) {
      throw new BadRequestException('A picture could not be attached - add it again');
    }

    await this.prisma.$transaction([
      this.prisma.hostingRestrictionMessage.create({
        data: {
          restrictionId: row.id,
          authorId: userId,
          fromStaff: false,
          text,
          imageUrls: keys.map((key) => this.storage.publicUrl(key)),
        },
      }),
      this.prisma.hostingRestriction.update({
        where: { id: row.id },
        data: { appealState: HostingAppealState.WAITING_STAFF },
      }),
    ]);
    this.events.emit(DomainEvents.HostingAppealSent, {
      restrictionId: row.id,
      userId,
      streamId: row.streamId,
    } satisfies HostingAppealSentPayload);
    return this.mine(userId, now);
  }

  // --- Staff (the admin console) ----------------------------------------------

  /**
   * Pauses [input.userId]'s hosting because of [input.streamId]. The title and
   * message are what the host reads - from a saved reason or written now
   * (and saved for next time with [input.saveAsReason]).
   */
  async restrict(
    staff: StaffActor,
    input: {
      userId: string;
      streamId?: string;
      reasonId?: string;
      title: string;
      message: string;
      note?: string;
      durationHours?: number | null;
      saveAsReason?: boolean;
    },
    now: Date = new Date(),
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (input.userId === staff.id)
      throw new BadRequestException("You can't restrict your own account");
    if (input.streamId) {
      const stream = await this.prisma.stream.findUnique({
        where: { id: input.streamId },
        select: { id: true },
      });
      if (!stream) throw new NotFoundException('Live not found');
    }
    const existing = await this.active(input.userId, now);
    if (existing) {
      throw new ConflictException({
        message: 'Their hosting is already paused - change that restriction instead.',
        code: 'ALREADY_RESTRICTED',
        restrictionId: existing.id,
      });
    }

    let reasonId = input.reasonId ?? null;
    if (reasonId) {
      const reason = await this.prisma.hostingRestrictionReason.findUnique({
        where: { id: reasonId },
        select: { id: true },
      });
      if (!reason) throw new NotFoundException('That reason no longer exists');
    } else if (input.saveAsReason) {
      const saved = await this.prisma.hostingRestrictionReason.create({
        data: { title: input.title, message: input.message, createdById: staff.id },
        select: { id: true, title: true },
      });
      reasonId = saved.id;
      this.events.emit(DomainEvents.HostingReasonSaved, {
        reasonId: saved.id,
        actorId: staff.id,
        title: saved.title,
        change: 'created',
      } satisfies HostingReasonSavedPayload);
    }

    const endsAt = input.durationHours
      ? new Date(now.getTime() + input.durationHours * 3_600_000)
      : null;
    const row = await this.prisma.hostingRestriction.create({
      data: {
        userId: input.userId,
        streamId: input.streamId ?? null,
        reasonId,
        title: input.title,
        message: input.message,
        note: input.note?.trim() || null,
        endsAt,
        createdById: staff.id,
      },
      select: { id: true },
    });
    this.events.emit(DomainEvents.HostingRestricted, {
      restrictionId: row.id,
      userId: input.userId,
      streamId: input.streamId ?? null,
      actorId: staff.id,
      title: input.title,
      endsAt,
    } satisfies HostingRestrictedPayload);
    return this.detail(row.id, now);
  }

  /** Hosting is back - with a word to the host, if [reply] is given. */
  async lift(staff: StaffActor, id: string, reply: string | undefined, now: Date = new Date()) {
    const row = await this.activeById(id, now);
    const text = reply?.trim() || null;
    await this.prisma.$transaction([
      ...(text
        ? [
            this.prisma.hostingRestrictionMessage.create({
              data: { restrictionId: id, authorId: staff.id, fromStaff: true, text },
            }),
          ]
        : []),
      this.prisma.hostingRestriction.update({
        where: { id },
        data: { liftedAt: now, liftedById: staff.id },
      }),
    ]);
    this.events.emit(DomainEvents.HostingRestrictionLifted, {
      restrictionId: id,
      userId: row.userId,
      streamId: row.streamId,
      actorId: staff.id,
      reply: text,
    } satisfies HostingRestrictionLiftedPayload);
    return this.detail(id, now);
  }

  /** The team answers the host: KEEP the restriction, or ASK for more. */
  async answer(
    staff: StaffActor,
    id: string,
    input: { decision: 'KEEP' | 'ASK'; text: string },
    now: Date = new Date(),
  ) {
    const row = await this.activeById(id, now);
    const text = input.text.trim();
    if (!text) throw new BadRequestException('Write your answer to the host');
    await this.prisma.$transaction([
      this.prisma.hostingRestrictionMessage.create({
        data: { restrictionId: id, authorId: staff.id, fromStaff: true, text },
      }),
      this.prisma.hostingRestriction.update({
        where: { id },
        data:
          input.decision === 'KEEP'
            ? { appealState: HostingAppealState.KEPT, keptAt: now }
            : { appealState: HostingAppealState.WAITING_HOST },
      }),
    ]);
    this.events.emit(DomainEvents.HostingAppealAnswered, {
      restrictionId: id,
      userId: row.userId,
      streamId: row.streamId,
      actorId: staff.id,
      decision: input.decision,
      reply: text,
    } satisfies HostingAppealAnsweredPayload);
    return this.detail(id, now);
  }

  /** How long it lasts (null: until lifted), and the team's own note. */
  async update(
    staff: StaffActor,
    id: string,
    input: { endsAt?: Date | null; note?: string | null },
    now: Date = new Date(),
  ) {
    const row = await this.activeById(id, now);
    const data: Prisma.HostingRestrictionUpdateInput = {};
    if (input.endsAt !== undefined) {
      if (input.endsAt && input.endsAt.getTime() <= now.getTime()) {
        throw new BadRequestException('Pick a time still to come - or lift it instead');
      }
      data.endsAt = input.endsAt;
    }
    if (input.note !== undefined) data.note = input.note?.trim() || null;
    const fields = Object.keys(data);
    if (fields.length === 0) return this.detail(id, now);
    await this.prisma.hostingRestriction.update({ where: { id }, data });
    this.events.emit(DomainEvents.HostingRestrictionChanged, {
      restrictionId: id,
      userId: row.userId,
      streamId: row.streamId,
      actorId: staff.id,
      fields,
    } satisfies HostingRestrictionChangedPayload);
    return this.detail(id, now);
  }

  /**
   * The restriction in force on each of [userIds] that has one - for the
   * console's host lists (Live chat, Lives), which only need a badge.
   */
  async inForce(userIds: string[], now: Date = new Date()) {
    if (userIds.length === 0) return [];
    const rows = await this.prisma.hostingRestriction.findMany({
      where: { userId: { in: userIds }, ...activeRestrictionWhere(now) },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        streamId: true,
        title: true,
        endsAt: true,
        appealState: true,
        createdAt: true,
      },
    });
    // One each (the newest), should two ever overlap.
    const seen = new Set<string>();
    return rows.filter((row) => !seen.has(row.userId) && seen.add(row.userId));
  }

  /** A page of restrictions, newest activity first, and how many wait for the team. */
  async list(
    query: PageQueryDto & {
      filter?: RestrictionFilter;
      streamId?: string;
      userId?: string;
      q?: string;
    },
    now: Date = new Date(),
  ) {
    const q = query.q?.trim();
    const where: Prisma.HostingRestrictionWhereInput = {
      ...(query.streamId ? { streamId: query.streamId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(q
        ? {
            user: {
              OR: [
                { username: { contains: q, mode: 'insensitive' } },
                { displayName: { contains: q, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
      ...this.filterWhere(query.filter ?? 'all', now),
    };
    const [rows, total, waiting, active] = await Promise.all([
      this.prisma.hostingRestriction.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        select: SUMMARY_SELECT,
        ...pageArgs(query),
      }),
      this.prisma.hostingRestriction.count({ where }),
      this.prisma.hostingRestriction.count({ where: this.filterWhere('waiting', now) }),
      this.prisma.hostingRestriction.count({ where: this.filterWhere('active', now) }),
    ]);
    return {
      ...toPage(
        rows.map((row) => this.summaryOf(row, now)),
        total,
        query,
      ),
      counts: { waiting, active },
    };
  }

  /** Everything about one restriction: the conversation, and the host's others. */
  async detail(id: string, now: Date = new Date()) {
    const row = await this.prisma.hostingRestriction.findUnique({
      where: { id },
      select: {
        ...SUMMARY_SELECT,
        reason: { select: { id: true, title: true } },
        messages: { orderBy: { createdAt: 'asc' }, select: MESSAGE_SELECT },
      },
    });
    if (!row) throw new NotFoundException('Restriction not found');
    const history = await this.prisma.hostingRestriction.findMany({
      where: { userId: row.user.id, id: { not: id } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        title: true,
        createdAt: true,
        liftedAt: true,
        endsAt: true,
        streamId: true,
      },
    });
    const { messages, reason, ...rest } = row;
    return {
      ...this.summaryOf({ ...rest, _count: { messages: messages.length } }, now),
      reason,
      messages,
      history: history.map((other) => ({ ...other, status: restrictionStatus(other, now) })),
    };
  }

  private summaryOf(row: SummaryRow, now: Date) {
    const { _count, keptAt, ...rest } = row;
    return {
      ...rest,
      keptAt,
      status: restrictionStatus(row, now),
      messageCount: _count.messages,
      // The host may write again from then (null: it's the team's turn).
      hostCanWriteFrom: appealOpensAt(row, now),
    };
  }

  private filterWhere(filter: RestrictionFilter, now: Date): Prisma.HostingRestrictionWhereInput {
    switch (filter) {
      case 'waiting':
        return { ...activeRestrictionWhere(now), appealState: HostingAppealState.WAITING_STAFF };
      case 'active':
        return activeRestrictionWhere(now);
      case 'ended':
        return { OR: [{ liftedAt: { not: null } }, { liftedAt: null, endsAt: { lte: now } }] };
      case 'all':
        return {};
    }
  }

  private async activeById(id: string, now: Date) {
    const row = await this.prisma.hostingRestriction.findUnique({
      where: { id },
      select: { id: true, userId: true, streamId: true, liftedAt: true, endsAt: true },
    });
    if (!row) throw new NotFoundException('Restriction not found');
    if (restrictionStatus(row, now) !== 'ACTIVE') {
      throw new ConflictException({
        message: 'This restriction is no longer in force',
        code: 'NOT_ACTIVE',
      });
    }
    return row;
  }
}
