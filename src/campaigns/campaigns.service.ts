import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AnnouncementTone,
  CampaignStatus,
  PlatformRole,
  Prisma,
  SessionPlatform,
  UserStatus,
} from '@prisma/client';
import {
  AnnouncementChangedPayload,
  CampaignChangedPayload,
  DomainEvents,
  FeaturedHostChangedPayload,
} from '../common/events/domain-events';
import { pageArgs, PageQueryDto, toPage } from '../common/pagination/page-query.dto';
import { PrismaService } from '../common/prisma/prisma.service';
import { PushQueueService } from '../notifications/push-queue.service';
import { audienceWhere, CampaignAudience, storedAudience } from './campaign-audience';

/** What a campaign push says it is (its data.type) - not a NotificationType: no inbox row. */
export const CAMPAIGN_PUSH_TYPE = 'CAMPAIGN';

// Recipients are looked up and queued this many at a time.
const SEND_BATCH = 500;

// What a tap or a banner button may open in the app.
const APP_PATH = /^\/(live|profile)\/[0-9a-fA-F-]{36}$/;

const PERSON = {
  select: { id: true, username: true, displayName: true, avatarUrl: true },
} as const;

export interface StaffActor {
  id: string;
}

export interface NewCampaign {
  title: string;
  body: string;
  openPath?: string;
  audience: CampaignAudience;
  // Null or past: now.
  scheduledAt?: Date;
}

export interface AnnouncementInput {
  title: string;
  message: string;
  tone?: AnnouncementTone;
  linkUrl?: string | null;
  linkLabel?: string | null;
  platform?: SessionPlatform | null;
  startsAt?: Date;
  endsAt?: Date | null;
  dismissible?: boolean;
}

/** A banner's link: https anywhere, or a live or profile in the app. */
export function checkLink(link: string | null | undefined): void {
  if (!link) return;
  if (APP_PATH.test(link)) return;
  try {
    if (new URL(link).protocol === 'https:') return;
  } catch {
    // Not a URL either.
  }
  throw new BadRequestException(
    'A link is https://… or a live or profile in the app (/live/…, /profile/…)',
  );
}

/**
 * Reaching many people at once (docs/features/campaigns.md): push campaigns
 * to an audience, now or later; banners at the top of the app's home screen;
 * and hosts featured first on For You. Staff actions are audited.
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);
  private sending = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushQueue: PushQueueService,
    private readonly events: EventEmitter2,
  ) {}

  // ---- Push campaigns

  /** How many accounts [audience] reaches right now. */
  async audienceSize(
    audience: CampaignAudience,
    now: Date = new Date(),
  ): Promise<{ count: number }> {
    return { count: await this.prisma.user.count({ where: audienceWhere(audience, now) }) };
  }

  async listCampaigns(query: PageQueryDto) {
    const [rows, total] = await Promise.all([
      this.prisma.pushCampaign.findMany({
        orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(query),
        include: { createdBy: PERSON, _count: { select: { opens: true } } },
      }),
      this.prisma.pushCampaign.count(),
    ]);
    return toPage(
      rows.map(({ _count, ...row }) => ({
        ...row,
        openCount: _count.opens,
        openRate:
          row.recipientCount > 0
            ? Math.round((_count.opens / row.recipientCount) * 1000) / 10
            : null,
      })),
      total,
      query,
    );
  }

  async createCampaign(staff: StaffActor, input: NewCampaign, now: Date = new Date()) {
    if (input.openPath && !APP_PATH.test(input.openPath)) {
      throw new BadRequestException('What it opens must be a live or a profile in the app');
    }
    const scheduledAt = input.scheduledAt && input.scheduledAt > now ? input.scheduledAt : now;
    const campaign = await this.prisma.pushCampaign.create({
      data: {
        title: input.title,
        body: input.body,
        openPath: input.openPath || null,
        audience: storedAudience(input.audience),
        scheduledAt,
        createdById: staff.id,
      },
    });
    this.events.emit(DomainEvents.CampaignScheduled, {
      campaignId: campaign.id,
      actorId: staff.id,
      title: campaign.title,
    } satisfies CampaignChangedPayload);
    // Now: out within seconds, not at the next tick.
    if (scheduledAt <= now) void this.sendDue(now);
    return campaign;
  }

  /** Only before it goes out. */
  async cancelCampaign(staff: StaffActor, campaignId: string) {
    const { count } = await this.prisma.pushCampaign.updateMany({
      where: { id: campaignId, status: CampaignStatus.SCHEDULED },
      data: { status: CampaignStatus.CANCELLED },
    });
    if (count === 0) {
      const exists = await this.prisma.pushCampaign.findUnique({
        where: { id: campaignId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Campaign not found');
      throw new ConflictException(
        'It went out already - only a scheduled campaign can be cancelled',
      );
    }
    const campaign = await this.prisma.pushCampaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    this.events.emit(DomainEvents.CampaignCancelled, {
      campaignId,
      actorId: staff.id,
      title: campaign.title,
    } satisfies CampaignChangedPayload);
    return campaign;
  }

  /**
   * Off the list, with its opens. Not while it's going out; a push already
   * delivered stays on people's phones - deleting can't take it back.
   */
  async deleteCampaign(staff: StaffActor, campaignId: string) {
    const campaign = await this.prisma.pushCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, title: true, status: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    const { count } = await this.prisma.pushCampaign.deleteMany({
      where: { id: campaignId, status: { not: CampaignStatus.SENDING } },
    });
    if (count === 0) {
      throw new ConflictException('It is going out right now - delete it once it is sent');
    }
    this.events.emit(DomainEvents.CampaignDeleted, {
      campaignId,
      actorId: staff.id,
      title: campaign.title,
    } satisfies CampaignChangedPayload);
    return { ok: true as const };
  }

  /**
   * Sends every campaign whose time has come (CampaignsJobs, every 30 s).
   * A campaign is claimed first (SCHEDULED to SENDING), so two instances
   * never send one twice.
   */
  async sendDue(now: Date = new Date()): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const due = await this.prisma.pushCampaign.findMany({
        where: { status: CampaignStatus.SCHEDULED, scheduledAt: { lte: now } },
        orderBy: { scheduledAt: 'asc' },
        take: 5,
      });
      for (const campaign of due) {
        const { count } = await this.prisma.pushCampaign.updateMany({
          where: { id: campaign.id, status: CampaignStatus.SCHEDULED },
          data: { status: CampaignStatus.SENDING },
        });
        if (count === 1) await this.send(campaign, now);
      }
    } finally {
      this.sending = false;
    }
  }

  private async send(
    campaign: {
      id: string;
      title: string;
      body: string;
      openPath: string | null;
      audience: Prisma.JsonValue;
    },
    now: Date,
  ): Promise<void> {
    try {
      const where = audienceWhere((campaign.audience ?? {}) as CampaignAudience, now);
      let sent = 0;
      let cursor: string | undefined;
      for (;;) {
        const batch = await this.prisma.user.findMany({
          where,
          select: { id: true },
          orderBy: { id: 'asc' },
          take: SEND_BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (batch.length === 0) break;
        await this.pushQueue.enqueueMany(
          batch.map((user) => ({
            recipientId: user.id,
            title: campaign.title,
            body: campaign.body,
            data: {
              type: CAMPAIGN_PUSH_TYPE,
              campaignId: campaign.id,
              ...(campaign.openPath ? { path: campaign.openPath } : {}),
            },
            collapseKey: `campaign:${campaign.id}`,
          })),
        );
        sent += batch.length;
        cursor = batch[batch.length - 1].id;
        if (batch.length < SEND_BATCH) break;
      }
      await this.prisma.pushCampaign.update({
        where: { id: campaign.id },
        data: { status: CampaignStatus.SENT, sentAt: new Date(), recipientCount: sent },
      });
    } catch (error) {
      this.logger.error(`Campaign ${campaign.id} failed: ${error}`);
      await this.prisma.pushCampaign
        .update({
          where: { id: campaign.id },
          data: { status: CampaignStatus.FAILED, failureReason: String(error).slice(0, 300) },
        })
        .catch(() => undefined);
    }
  }

  /** The app was opened from this campaign's push - counted once per person. */
  async recordOpen(userId: string, campaignId: string): Promise<{ ok: true }> {
    const exists = await this.prisma.pushCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (exists) {
      await this.prisma.pushCampaignOpen.createMany({
        data: [{ campaignId, userId }],
        skipDuplicates: true,
      });
    }
    return { ok: true };
  }

  // ---- Banners

  async listAnnouncements(query: PageQueryDto) {
    const [rows, total] = await Promise.all([
      this.prisma.announcement.findMany({
        orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(query),
        include: { createdBy: PERSON },
      }),
      this.prisma.announcement.count(),
    ]);
    return toPage(rows, total, query);
  }

  /** What the app shows now, on [platform] - newest first. */
  async activeAnnouncements(platform: SessionPlatform | undefined, now: Date = new Date()) {
    return this.prisma.announcement.findMany({
      where: {
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        AND: [{ OR: [{ platform: null }, ...(platform ? [{ platform }] : [])] }],
      },
      orderBy: { startsAt: 'desc' },
      take: 3,
      select: {
        id: true,
        title: true,
        message: true,
        tone: true,
        linkUrl: true,
        linkLabel: true,
        dismissible: true,
        updatedAt: true,
      },
    });
  }

  async createAnnouncement(staff: StaffActor, input: AnnouncementInput, now: Date = new Date()) {
    checkLink(input.linkUrl);
    const startsAt = input.startsAt ?? now;
    if (input.endsAt && input.endsAt <= startsAt)
      throw new BadRequestException('It must end after it starts');
    const announcement = await this.prisma.announcement.create({
      data: {
        title: input.title,
        message: input.message,
        tone: input.tone ?? AnnouncementTone.INFO,
        linkUrl: input.linkUrl || null,
        linkLabel: input.linkUrl ? input.linkLabel || 'Open' : null,
        platform: input.platform ?? null,
        startsAt,
        endsAt: input.endsAt ?? null,
        dismissible: input.dismissible ?? true,
        createdById: staff.id,
      },
    });
    this.announcementChanged('published', staff, announcement);
    return announcement;
  }

  async updateAnnouncement(staff: StaffActor, id: string, input: Partial<AnnouncementInput>) {
    const current = await this.prisma.announcement.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Banner not found');
    if (input.linkUrl !== undefined) checkLink(input.linkUrl);
    const startsAt = input.startsAt ?? current.startsAt;
    const endsAt = input.endsAt === undefined ? current.endsAt : input.endsAt;
    if (endsAt && endsAt <= startsAt) throw new BadRequestException('It must end after it starts');
    const linkUrl = input.linkUrl === undefined ? current.linkUrl : input.linkUrl || null;
    const announcement = await this.prisma.announcement.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.tone !== undefined ? { tone: input.tone } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.dismissible !== undefined ? { dismissible: input.dismissible } : {}),
        linkUrl,
        linkLabel: linkUrl ? (input.linkLabel ?? current.linkLabel) || 'Open' : null,
        startsAt,
        endsAt,
      },
    });
    this.announcementChanged('updated', staff, announcement);
    return announcement;
  }

  /** Off the app now; kept in the list. */
  async endAnnouncement(staff: StaffActor, id: string, now: Date = new Date()) {
    const current = await this.prisma.announcement.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Banner not found');
    const announcement = await this.prisma.announcement.update({
      where: { id },
      data: { endsAt: now, ...(current.startsAt > now ? { startsAt: now } : {}) },
    });
    this.announcementChanged('ended', staff, announcement);
    return announcement;
  }

  async deleteAnnouncement(staff: StaffActor, id: string) {
    const current = await this.prisma.announcement.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Banner not found');
    await this.prisma.announcement.delete({ where: { id } });
    this.announcementChanged('deleted', staff, current);
    return { ok: true as const };
  }

  private announcementChanged(
    change: AnnouncementChangedPayload['change'],
    staff: StaffActor,
    announcement: { id: string; title: string },
  ) {
    this.events.emit(DomainEvents.AnnouncementChanged, {
      change,
      announcementId: announcement.id,
      actorId: staff.id,
      title: announcement.title,
    } satisfies AnnouncementChangedPayload);
  }

  // ---- Featured hosts

  async listFeatured(now: Date = new Date()) {
    const rows = await this.prisma.featuredHost.findMany({
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: { select: { ...PERSON.select, status: true } },
        createdBy: PERSON,
      },
    });
    const live = await this.prisma.stream.findMany({
      where: { hostId: { in: rows.map((row) => row.userId) }, status: 'LIVE' },
      select: { id: true, hostId: true },
    });
    return {
      items: rows.map((row) => ({
        ...row,
        active: !row.endsAt || row.endsAt > now,
        liveStreamId: live.find((stream) => stream.hostId === row.userId)?.id ?? null,
      })),
    };
  }

  async feature(
    staff: StaffActor,
    input: { userId: string; note?: string | null; endsAt?: Date | null; position?: number },
  ) {
    const host = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, username: true, status: true, platformRole: true },
    });
    if (!host) throw new NotFoundException('User not found');
    if (host.status !== UserStatus.ACTIVE)
      throw new BadRequestException('A suspended account cannot be featured');
    if (host.platformRole !== PlatformRole.USER)
      throw new BadRequestException('Staff accounts are not featured');
    const last = await this.prisma.featuredHost.aggregate({ _max: { position: true } });
    const featured = await this.prisma.featuredHost.upsert({
      where: { userId: host.id },
      create: {
        userId: host.id,
        note: input.note || null,
        endsAt: input.endsAt ?? null,
        position: input.position ?? (last._max.position ?? -1) + 1,
        createdById: staff.id,
      },
      update: {
        note: input.note === undefined ? undefined : input.note || null,
        endsAt: input.endsAt === undefined ? undefined : input.endsAt,
        position: input.position,
      },
    });
    this.events.emit(DomainEvents.FeaturedHostChanged, {
      change: 'added',
      userId: host.id,
      actorId: staff.id,
    } satisfies FeaturedHostChangedPayload);
    return featured;
  }

  async unfeature(staff: StaffActor, userId: string) {
    const { count } = await this.prisma.featuredHost.deleteMany({ where: { userId } });
    if (count === 0) throw new NotFoundException('Not featured');
    this.events.emit(DomainEvents.FeaturedHostChanged, {
      change: 'removed',
      userId,
      actorId: staff.id,
    } satisfies FeaturedHostChangedPayload);
    return { ok: true as const };
  }

  /** The order of the featured list, top first. */
  async reorderFeatured(staff: StaffActor, userIds: string[]) {
    await this.prisma.$transaction(
      userIds.map((userId, position) =>
        this.prisma.featuredHost.updateMany({ where: { userId }, data: { position } }),
      ),
    );
    this.events.emit(DomainEvents.FeaturedHostChanged, {
      change: 'reordered',
      userId: null,
      actorId: staff.id,
    } satisfies FeaturedHostChangedPayload);
    return this.listFeatured();
  }
}
