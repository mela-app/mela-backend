import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Prisma, StreamVisibility } from '@prisma/client';
import {
  DomainEvents,
  HostingRestrictedPayload,
  ScheduledLiveStartingSoonPayload,
} from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { HostingRestrictionsService } from '../hosting-restrictions/hosting-restrictions.service';
import { notBlockedEitherWayWith } from '../social/block-filters';
import { SocialService } from '../social/social.service';
import { canWatchLive } from '../streams/live-audience';
import { CreateScheduledLiveDto } from './dto/create-scheduled-live.dto';
import {
  LATE_GRACE_MS,
  MAX_LEAD_MS,
  MAX_UPCOMING_PER_HOST,
  MIN_LEAD_MS,
  REMIND_BEFORE_MS,
  upcomingWhere,
} from './scheduled-live-window';

const FEED_DAYS = 7;

const PERSON_SELECT = { id: true, username: true, displayName: true, avatarUrl: true } as const;
const SCHEDULED_SELECT = {
  id: true,
  title: true,
  category: true,
  visibility: true,
  startsAt: true,
  hostId: true,
  host: { select: PERSON_SELECT },
  _count: { select: { reminders: true } },
} as const;

type ScheduledRow = Prisma.ScheduledLiveGetPayload<{ select: typeof SCHEDULED_SELECT }>;

export interface ScheduledLiveView {
  id: string;
  title: string;
  category: string | null;
  visibility: StreamVisibility;
  startsAt: Date;
  host: { id: string; username: string; displayName: string; avatarUrl: string | null };
  reminderCount: number;
  /** Whether the person asking set a reminder for it. */
  reminded: boolean;
}

/**
 * Lives a host announces ahead (docs/features/streams.md, "Scheduled
 * lives"): shown on their profile and in their followers' Following tab,
 * each with "Remind me". Shortly before it starts the reminded get a
 * "starting soon" notification; when the host goes live from it
 * (StreamsService.goLive with its id) they're told it's live, followers or
 * not. Who may see one follows its visibility, like a live.
 */
@Injectable()
export class ScheduledLivesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly social: SocialService,
    private readonly events: EventEmitter2,
    private readonly hosting: HostingRestrictionsService,
  ) {}

  async create(hostId: string, dto: CreateScheduledLiveDto, now = new Date()) {
    await this.hosting.assertCanHost(hostId, now);
    const lead = dto.startsAt.getTime() - now.getTime();
    if (!Number.isFinite(lead) || lead < MIN_LEAD_MS) {
      throw new BadRequestException('Pick a time at least 5 minutes from now');
    }
    if (lead > MAX_LEAD_MS) throw new BadRequestException('Pick a time within the next 30 days');
    const upcoming = await this.prisma.scheduledLive.count({
      where: { hostId, ...upcomingWhere(now) },
    });
    if (upcoming >= MAX_UPCOMING_PER_HOST) {
      throw new ConflictException(
        `You already have ${MAX_UPCOMING_PER_HOST} lives coming up. Cancel one to add another`,
      );
    }
    const row = await this.prisma.scheduledLive.create({
      data: {
        hostId,
        title: dto.title.trim(),
        category: dto.category?.trim() || null,
        visibility: dto.visibility ?? StreamVisibility.PUBLIC,
        startsAt: dto.startsAt,
      },
      select: SCHEDULED_SELECT,
    });
    return view(row, false);
  }

  /** The host's own upcoming lives, soonest first. */
  async mine(hostId: string, now = new Date()): Promise<{ items: ScheduledLiveView[] }> {
    const rows = await this.prisma.scheduledLive.findMany({
      where: { hostId, ...upcomingWhere(now) },
      orderBy: { startsAt: 'asc' },
      select: SCHEDULED_SELECT,
    });
    return { items: rows.map((row) => view(row, false)) };
  }

  /** One host's upcoming lives that [viewerId] may see (their profile), soonest first. */
  async ofHost(hostId: string, viewerId: string | undefined, now = new Date()) {
    if (viewerId && (await this.social.isBlockedEitherWay(hostId, viewerId))) return { items: [] };
    const rows = await this.prisma.scheduledLive.findMany({
      where: { hostId, ...upcomingWhere(now) },
      orderBy: { startsAt: 'asc' },
      select: SCHEDULED_SELECT,
    });
    const visible = await this.visibleTo(rows, viewerId);
    return { items: await this.withReminded(visible, viewerId) };
  }

  /** Upcoming lives in the next week from the hosts [viewerId] follows (the Following tab). */
  async following(viewerId: string, now = new Date()) {
    const follows = await this.prisma.follow.findMany({
      where: { followerId: viewerId },
      select: { followeeId: true },
    });
    if (follows.length === 0) return { items: [] };
    const rows = await this.prisma.scheduledLive.findMany({
      where: {
        hostId: { in: follows.map((row) => row.followeeId) },
        host: notBlockedEitherWayWith(viewerId),
        ...upcomingWhere(now),
        startsAt: {
          gte: new Date(now.getTime() - LATE_GRACE_MS),
          lte: new Date(now.getTime() + FEED_DAYS * 24 * 60 * 60 * 1000),
        },
      },
      orderBy: { startsAt: 'asc' },
      take: 50,
      select: SCHEDULED_SELECT,
    });
    const visible = await this.visibleTo(rows, viewerId);
    return { items: await this.withReminded(visible, viewerId) };
  }

  /** Their hosting was paused: what they announced won't happen, so nobody waits for it. */
  @OnEvent(DomainEvents.HostingRestricted)
  async cancelForRestrictedHost({ userId }: HostingRestrictedPayload, now = new Date()) {
    await this.prisma.scheduledLive.updateMany({
      where: { hostId: userId, ...upcomingWhere(now) },
      data: { cancelledAt: now },
    });
  }

  async cancel(id: string, hostId: string) {
    const { count } = await this.prisma.scheduledLive.updateMany({
      where: { id, hostId, cancelledAt: null, streamId: null },
      data: { cancelledAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('That scheduled live is not coming up');
    return { ok: true };
  }

  async setReminder(id: string, userId: string, on: boolean, now = new Date()) {
    const row = await this.prisma.scheduledLive.findFirst({
      where: { id, ...upcomingWhere(now) },
      select: SCHEDULED_SELECT,
    });
    if (!row || (await this.social.isBlockedEitherWay(row.hostId, userId))) {
      throw new NotFoundException('That scheduled live is not coming up');
    }
    if (row.hostId === userId)
      throw new ForbiddenException("You can't remind yourself of your own live");
    if (on) {
      if ((await this.visibleTo([row], userId)).length === 0) {
        throw new NotFoundException('That scheduled live is not coming up');
      }
      await this.prisma.scheduledLiveReminder.upsert({
        where: { scheduledLiveId_userId: { scheduledLiveId: id, userId } },
        create: { scheduledLiveId: id, userId },
        update: {},
      });
    } else {
      await this.prisma.scheduledLiveReminder.deleteMany({
        where: { scheduledLiveId: id, userId },
      });
    }
    const reminderCount = await this.prisma.scheduledLiveReminder.count({
      where: { scheduledLiveId: id },
    });
    return { reminded: on, reminderCount };
  }

  /**
   * Sends each scheduled live's "starting soon" once, about
   * {@link REMIND_BEFORE_MS} ahead (ScheduledLiveReminderJob runs it every
   * minute). Answers how many lives' reminders went out.
   */
  async sendDueReminders(now = new Date()): Promise<number> {
    const due = await this.prisma.scheduledLive.findMany({
      where: {
        ...upcomingWhere(now),
        remindedAt: null,
        startsAt: {
          lte: new Date(now.getTime() + REMIND_BEFORE_MS),
          gte: new Date(now.getTime() - LATE_GRACE_MS),
        },
      },
      select: { id: true, hostId: true, title: true, startsAt: true, visibility: true },
      take: 100,
    });
    let sent = 0;
    for (const live of due) {
      // Claimed once, whichever instance or round gets here first.
      const { count } = await this.prisma.scheduledLive.updateMany({
        where: { id: live.id, remindedAt: null },
        data: { remindedAt: now },
      });
      if (count === 0) continue;
      const reminders = await this.prisma.scheduledLiveReminder.findMany({
        where: { scheduledLiveId: live.id },
        select: { userId: true },
      });
      if (reminders.length === 0) continue;
      this.events.emit(DomainEvents.ScheduledLiveStartingSoon, {
        scheduledLiveId: live.id,
        hostId: live.hostId,
        title: live.title,
        startsAt: live.startsAt,
        userIds: reminders.map((row) => row.userId),
      } satisfies ScheduledLiveStartingSoonPayload);
      sent++;
    }
    return sent;
  }

  // Each row the viewer may see by its visibility (an anonymous viewer: public ones).
  private async visibleTo(
    rows: ScheduledRow[],
    viewerId: string | undefined,
  ): Promise<ScheduledRow[]> {
    const restrictedHosts = [
      ...new Set(
        rows.filter((row) => row.visibility !== StreamVisibility.PUBLIC).map((row) => row.hostId),
      ),
    ];
    const relations = new Map<string, { follows: boolean; isFriend: boolean }>();
    if (viewerId) {
      await Promise.all(
        restrictedHosts.map(async (hostId) => {
          const [follows, followedBack] = await Promise.all([
            this.social.isFollowing(viewerId, hostId),
            this.social.isFollowing(hostId, viewerId),
          ]);
          relations.set(hostId, { follows, isFriend: follows && followedBack });
        }),
      );
    }
    return rows.filter((row) => {
      const relation = relations.get(row.hostId);
      return canWatchLive(
        row.visibility,
        viewerId
          ? {
              isHost: row.hostId === viewerId,
              follows: relation?.follows ?? false,
              isFriend: relation?.isFriend ?? false,
            }
          : null,
      );
    });
  }

  private async withReminded(rows: ScheduledRow[], viewerId: string | undefined) {
    if (!viewerId || rows.length === 0) return rows.map((row) => view(row, false));
    const mine = await this.prisma.scheduledLiveReminder.findMany({
      where: { userId: viewerId, scheduledLiveId: { in: rows.map((row) => row.id) } },
      select: { scheduledLiveId: true },
    });
    const reminded = new Set(mine.map((row) => row.scheduledLiveId));
    return rows.map((row) => view(row, reminded.has(row.id)));
  }
}

function view(row: ScheduledRow, reminded: boolean): ScheduledLiveView {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    visibility: row.visibility,
    startsAt: row.startsAt,
    host: row.host,
    reminderCount: row._count.reminders,
    reminded,
  };
}
