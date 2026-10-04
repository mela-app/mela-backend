import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { GuestRequestInitiator, NotificationType, Prisma } from '@prisma/client';
import {
  DomainEvents,
  GuestRequestCreatedPayload,
  ModeratorGrantedPayload,
  NotificationCreatedPayload,
  StreamInviteSentPayload,
  StreamStartedPayload,
  UserFollowedPayload,
} from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { notBlockedEitherWayWith } from '../social/block-filters';
import { SocialService } from '../social/social.service';
import { MarkNotificationsReadDto } from './dto/mark-notifications-read.dto';
import { UpdateNotificationSettingsDto } from './dto/notification-settings.dto';
import { PushQueueService } from './push-queue.service';

// A host who restarts a live within this window (crash, lost signal - which
// the auto-end-previous-live behavior in StreamsService.goLive() makes
// routine) does not notify their followers twice (plan §6.11). Short, so a
// host who ends a live and starts a new one soon after still reaches them.
const GOLIVE_COOLDOWN_SECONDS = 5 * 60;
// Chunked so one go-live for a very-followed host never builds one giant
// createMany call.
const FOLLOWER_FANOUT_CHUNK_SIZE = 1000;

const NOTIFICATION_SELECT = {
  id: true,
  recipientId: true,
  type: true,
  actorId: true,
  streamId: true,
  readAt: true,
  createdAt: true,
} as const;

const PROFILE_SUMMARY_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

// Hydrated for the inbox (list()) - always read fresh from the relations
// rather than denormalized onto the row, so a display name change shows up
// immediately. actor/stream are null once deleted (onDelete: SetNull).
const NOTIFICATION_LIST_SELECT = {
  id: true,
  type: true,
  readAt: true,
  createdAt: true,
  actor: { select: PROFILE_SUMMARY_SELECT },
  stream: { select: { id: true, title: true } },
} as const;

// Someone's inbox, without anything from a person blocked either way (plan
// §6.4) - a notification with no actor (deleted account) still shows.
function inboxOf(recipientId: string): Prisma.NotificationWhereInput {
  return { recipientId, OR: [{ actorId: null }, { actor: notBlockedEitherWayWith(recipientId) }] };
}

export interface SettingsView {
  pushStreamStarted: boolean;
  pushNewFollower: boolean;
  pushStreamInvite: boolean;
  pushModeratorGranted: boolean;
  pushGuestInvite: boolean;
}

const DEFAULT_SETTINGS: SettingsView = {
  pushStreamStarted: true,
  pushNewFollower: true,
  pushStreamInvite: true,
  pushModeratorGranted: true,
  pushGuestInvite: true,
};

// Which per-type toggle in NotificationSettings gates a push for that type.
const SETTING_KEY_BY_TYPE: Record<NotificationType, keyof SettingsView> = {
  STREAM_STARTED: 'pushStreamStarted',
  NEW_FOLLOWER: 'pushNewFollower',
  STREAM_INVITE: 'pushStreamInvite',
  MODERATOR_GRANTED: 'pushModeratorGranted',
  GUEST_INVITE: 'pushGuestInvite',
};

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * One in-app row is always written; a push is queued separately (and only
 * sent if the recipient allows that type - see PushProcessor). See
 * docs/features/notifications.md.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
    private readonly social: SocialService,
    private readonly pushQueue: PushQueueService,
  ) {}

  // Emitted by StreamsService.goLive() - StreamsModule never imports this
  // module (plan §4.1 / docs/features/events.md).
  @OnEvent(DomainEvents.StreamStarted)
  async onStreamStarted(payload: StreamStartedPayload): Promise<void> {
    const cooldownKey = `notif:golive:${payload.hostId}`;
    const acquired = await this.redis
      .getClient()
      .set(cooldownKey, '1', 'EX', GOLIVE_COOLDOWN_SECONDS, 'NX');
    if (acquired !== 'OK') return;

    const followers = await this.prisma.follow.findMany({
      where: { followeeId: payload.hostId, notifyOnLive: true, follower: { status: 'ACTIVE' } },
      select: { followerId: true },
    });
    if (followers.length === 0) return;
    const blocked = new Set(await this.social.blockedEitherWayUserIds(payload.hostId));
    const recipientIds = followers.map((row) => row.followerId).filter((id) => !blocked.has(id));
    if (recipientIds.length === 0) return;

    const host = await this.prisma.user.findUnique({
      where: { id: payload.hostId },
      select: PROFILE_SUMMARY_SELECT,
    });
    const hostName = host?.displayName ?? 'Someone you follow';

    for (let i = 0; i < recipientIds.length; i += FOLLOWER_FANOUT_CHUNK_SIZE) {
      const chunk = recipientIds.slice(i, i + FOLLOWER_FANOUT_CHUNK_SIZE);
      await this.fanOut(chunk, {
        type: NotificationType.STREAM_STARTED,
        actorId: payload.hostId,
        streamId: payload.streamId,
        title: 'Live now',
        body: `${hostName} is live: ${payload.title}`,
        actor: host,
        streamTitle: payload.title,
      });
    }
  }

  @OnEvent(DomainEvents.UserFollowed)
  async onUserFollowed(payload: UserFollowedPayload): Promise<void> {
    const follower = await this.prisma.user.findUnique({
      where: { id: payload.followerId },
      select: PROFILE_SUMMARY_SELECT,
    });
    await this.fanOut([payload.followeeId], {
      type: NotificationType.NEW_FOLLOWER,
      actorId: payload.followerId,
      streamId: null,
      title: 'New follower',
      body: `${follower?.displayName ?? 'Someone'} started following you`,
      actor: follower,
      streamTitle: null,
    });
  }

  @OnEvent(DomainEvents.ModeratorGranted)
  async onModeratorGranted(payload: ModeratorGrantedPayload): Promise<void> {
    const host = await this.prisma.user.findUnique({
      where: { id: payload.hostId },
      select: PROFILE_SUMMARY_SELECT,
    });
    await this.fanOut([payload.userId], {
      type: NotificationType.MODERATOR_GRANTED,
      actorId: payload.hostId,
      streamId: payload.streamId,
      title: "You're a moderator",
      body: `${host?.displayName ?? 'A host'} made you a moderator for this stream`,
      actor: host,
      streamTitle: null,
    });
  }

  // Emitted by ShareService, already filtered to friends and past the cap/rate limit (plan §6.12).
  @OnEvent(DomainEvents.StreamInviteSent)
  async onStreamInviteSent(payload: StreamInviteSentPayload): Promise<void> {
    const [sender, stream] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: payload.senderId },
        select: PROFILE_SUMMARY_SELECT,
      }),
      this.prisma.stream.findUnique({ where: { id: payload.streamId }, select: { title: true } }),
    ]);
    await this.fanOut(payload.recipientIds, {
      type: NotificationType.STREAM_INVITE,
      actorId: payload.senderId,
      streamId: payload.streamId,
      title: 'Live invite',
      body: `${sender?.displayName ?? 'Someone'} invited you to a live${stream ? `: ${stream.title}` : ''}`,
      actor: sender,
      streamTitle: stream?.title ?? null,
    });
  }

  // Only the HOST-initiated direction is a real "invite" worth a durable
  // notification (plan §6.11's GUEST_INVITE) - a viewer's own raised hand
  // already reaches the host live via `guest_request:new`; it doesn't also
  // need a stored notification about their own action.
  @OnEvent(DomainEvents.GuestRequestCreated)
  async onGuestRequestCreated(payload: GuestRequestCreatedPayload): Promise<void> {
    if (payload.initiatedBy !== GuestRequestInitiator.HOST) return;
    const stream = await this.prisma.stream.findUnique({
      where: { id: payload.streamId },
      select: { hostId: true, title: true },
    });
    if (!stream) return;
    const host = await this.prisma.user.findUnique({
      where: { id: stream.hostId },
      select: PROFILE_SUMMARY_SELECT,
    });
    await this.fanOut([payload.user.id], {
      type: NotificationType.GUEST_INVITE,
      actorId: stream.hostId,
      streamId: payload.streamId,
      title: 'Invited on stage',
      body: `${host?.displayName ?? 'A host'} invited you to join their live: ${stream.title}`,
      actor: host,
      streamTitle: stream.title,
    });
  }

  /** Cursor-paginated inbox, newest first (plan §6.11). */
  async list(recipientId: string, cursor?: string, limit = 30): Promise<Page<unknown>> {
    const rows = await this.prisma.notification.findMany({
      where: { ...inboxOf(recipientId), ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: NOTIFICATION_LIST_SELECT,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items, hasMore, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async unreadCount(recipientId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { ...inboxOf(recipientId), readAt: null },
    });
    return { count };
  }

  async markRead(recipientId: string, dto: MarkNotificationsReadDto): Promise<{ ok: true }> {
    if (dto.all) {
      await this.prisma.notification.updateMany({
        where: { recipientId, readAt: null },
        data: { readAt: new Date() },
      });
      return { ok: true };
    }
    if (dto.ids && dto.ids.length > 0) {
      await this.prisma.notification.updateMany({
        where: { recipientId, id: { in: dto.ids } },
        data: { readAt: new Date() },
      });
      return { ok: true };
    }
    throw new BadRequestException('Provide either "all" or a non-empty "ids"');
  }

  async setPushToken(sessionId: string | undefined, token: string): Promise<{ ok: true }> {
    if (!sessionId) throw new BadRequestException('Sign in again on this device first');
    // A device reused by another account after a sign-out: only the current session gets its pushes.
    await this.prisma.userSession.updateMany({
      where: { pushToken: token, id: { not: sessionId } },
      data: { pushToken: null },
    });
    const result = await this.prisma.userSession.updateMany({
      where: { id: sessionId },
      data: { pushToken: token },
    });
    if (result.count === 0) throw new NotFoundException('Session not found');
    return { ok: true };
  }

  async clearPushToken(sessionId: string | undefined): Promise<{ ok: true }> {
    if (!sessionId) return { ok: true };
    await this.prisma.userSession.updateMany({
      where: { id: sessionId },
      data: { pushToken: null },
    });
    return { ok: true };
  }

  async getSettings(userId: string): Promise<SettingsView> {
    const row = await this.prisma.notificationSettings.findUnique({ where: { userId } });
    return row
      ? {
          pushStreamStarted: row.pushStreamStarted,
          pushNewFollower: row.pushNewFollower,
          pushStreamInvite: row.pushStreamInvite,
          pushModeratorGranted: row.pushModeratorGranted,
          pushGuestInvite: row.pushGuestInvite,
        }
      : DEFAULT_SETTINGS;
  }

  async updateSettings(userId: string, dto: UpdateNotificationSettingsDto): Promise<SettingsView> {
    const row = await this.prisma.notificationSettings.upsert({
      where: { userId },
      create: { userId, ...DEFAULT_SETTINGS, ...dto },
      update: { ...dto },
    });
    return {
      pushStreamStarted: row.pushStreamStarted,
      pushNewFollower: row.pushNewFollower,
      pushStreamInvite: row.pushStreamInvite,
      pushModeratorGranted: row.pushModeratorGranted,
      pushGuestInvite: row.pushGuestInvite,
    };
  }

  /** Writes one row per recipient, nudges each one's `user:{id}` room, and queues a push per this type's setting. */
  private async fanOut(
    recipientIds: string[],
    input: {
      type: NotificationType;
      actorId: string | null;
      streamId: string | null;
      title: string;
      body: string;
      // Already fetched by the caller for the push text - reused here for the
      // realtime payload too, instead of a second lookup per recipient.
      actor:
        | { id: string; username: string; displayName: string; avatarUrl: string | null }
        | null
        | undefined;
      streamTitle: string | null;
    },
  ): Promise<void> {
    if (recipientIds.length === 0) return;
    const created = await this.prisma.notification.createManyAndReturn({
      data: recipientIds.map((recipientId) => ({
        recipientId,
        type: input.type,
        actorId: input.actorId,
        streamId: input.streamId,
      })),
      select: NOTIFICATION_SELECT,
    });

    const settingKey = SETTING_KEY_BY_TYPE[input.type];
    const settingsRows = await this.prisma.notificationSettings.findMany({
      where: { userId: { in: recipientIds } },
      select: {
        userId: true,
        pushStreamStarted: true,
        pushNewFollower: true,
        pushStreamInvite: true,
        pushModeratorGranted: true,
        pushGuestInvite: true,
      },
    });
    const pushDisabledFor = new Set(
      settingsRows.filter((row) => row[settingKey] === false).map((row) => row.userId),
    );

    for (const row of created) {
      this.events.emit(DomainEvents.NotificationCreated, {
        recipientId: row.recipientId,
        notification: {
          id: row.id,
          type: row.type,
          actorId: row.actorId,
          streamId: row.streamId,
          createdAt: row.createdAt,
          actor: input.actor ?? null,
          streamTitle: input.streamTitle,
        },
      } satisfies NotificationCreatedPayload);

      if (!pushDisabledFor.has(row.recipientId)) {
        await this.pushQueue
          .enqueue({
            recipientId: row.recipientId,
            title: input.title,
            body: input.body,
            // What a tap on the push opens (FCM data values are strings).
            data: {
              type: row.type,
              ...(row.streamId ? { streamId: row.streamId } : {}),
              ...(row.actorId ? { actorId: row.actorId } : {}),
            },
          })
          .catch((error) =>
            this.logger.warn(`Could not queue push for ${row.recipientId}: ${error}`),
          );
      }
    }
  }
}
