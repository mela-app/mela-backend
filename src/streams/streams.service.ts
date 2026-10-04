import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  GuestRequestInitiator,
  ModeratorCapability,
  Prisma,
  RoomBanScope,
  Stream,
  StreamEndReason,
  StreamLayout,
  StreamStatus,
  UserStatus,
} from '@prisma/client';
import { PermissionsService } from '../common/permissions/permissions.service';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  DomainEvents,
  LiveAccessRevokedPayload,
  StreamEndedPayload,
  StreamLayoutChangedPayload,
  StreamLockedPayload,
  StreamStartedPayload,
  StreamUnlockedPayload,
  UserBlockedPayload,
} from '../common/events/domain-events';
import {
  HOST_HEARTBEAT_TTL_SECONDS,
  LivePresenceService,
} from '../common/presence/live-presence.service';
import { VideoProviderRegistry } from '../common/video-provider/video-provider.registry';
import { agoraUidFor } from '../common/video-provider/agora-video-provider.service';
import { GuestsService, MAX_ACTIVE_GUESTS } from '../guests/guests.service';
import { ModeratorsService } from '../moderators/moderators.service';
import { RecordingPermissionsService } from '../recording-permissions/recording-permissions.service';
import { RoomBansService } from '../room-bans/room-bans.service';
import { RoomChatMutesService } from '../room-chat-mutes/room-chat-mutes.service';
import { SocialService } from '../social/social.service';
import { WatchTicketService } from '../auth/watch-ticket.service';
import { chatPreviewText } from '../chat/chat-images';
import { CreateStreamDto } from './dto/create-stream.dto';
import { ListStreamsQueryDto } from './dto/list-streams.dto';

// Who someone is in a live: the host, a viewer, a guest.
const PARTICIPANT_SELECT = { id: true, username: true, displayName: true, avatarUrl: true } as const;

const HOST_PUBLIC_SELECT = { select: PARTICIPANT_SELECT } as const;

const STREAM_LIST_SELECT = {
  id: true,
  title: true,
  category: true,
  status: true,
  startedAt: true,
  endedAt: true,
  host: HOST_PUBLIC_SELECT,
} as const;

const STREAM_DETAIL_SELECT = {
  id: true,
  title: true,
  category: true,
  status: true,
  layout: true,
  startedAt: true,
  endedAt: true,
  endedReason: true,
  peakViewerCount: true,
  likeCount: true,
  host: HOST_PUBLIC_SELECT,
} as const;

// Lives are few (tens to hundreds), so the list is ranked in memory by the
// viewer counts Redis holds; this caps how many a single request ranks.
const MAX_RANKED_LIVES = 500;

@Injectable()
export class StreamsService {
  private readonly logger = new Logger(StreamsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly videoProviders: VideoProviderRegistry,
    private readonly events: EventEmitter2,
    private readonly presence: LivePresenceService,
    private readonly social: SocialService,
    private readonly moderators: ModeratorsService,
    private readonly roomBans: RoomBansService,
    private readonly guests: GuestsService,
    private readonly roomChatMutes: RoomChatMutesService,
    private readonly watchTickets: WatchTicketService,
    private readonly recordingPermissions: RecordingPermissionsService,
  ) {}

  getVideoConfig() {
    return this.videoProviders.active().getClientConfig();
  }

  async goLive(hostId: string, dto: CreateStreamDto) {
    // A host can only have one live stream at a time - starting a new one
    // auto-ends any dangling previous one (e.g. the app crashed/disconnected
    // before the host could tap "End stream"), rather than leaving a zombie
    // LIVE row forever or blocking the host from ever going live again.
    const previousLive = await this.prisma.stream.findFirst({
      where: { hostId, status: StreamStatus.LIVE },
    });
    if (previousLive) {
      await this.endStream(previousLive.id, StreamEndReason.REPLACED);
    }

    // Generate the id ourselves so the channel name can be derived and
    // stored in the same insert - no placeholder row, no race condition.
    const id = randomUUID();
    const videoProvider = this.videoProviders.active();
    const channelName = videoProvider.createChannelName(id);
    await videoProvider.openChannel(channelName);

    const stream = await this.prisma.stream.create({
      data: {
        id,
        hostId,
        title: dto.title,
        category: dto.category,
        layout: dto.layout,
        status: StreamStatus.LIVE,
        videoProvider: videoProvider.kind,
        channelName,
      },
      include: { host: HOST_PUBLIC_SELECT },
    });

    // Counts as the host's first heartbeat, so the app has the full grace
    // window to connect its realtime socket.
    await this.presence
      .touchHost(id)
      .catch((error) => this.logger.warn(`Could not mark host ${hostId} alive: ${error}`));

    const rtcToken = await videoProvider.mintToken({
      channelName,
      userId: hostId,
      role: 'publisher',
    });

    // Fan-out (follower notifications) happens entirely out of this request's
    // path - NotificationsService reacts to this on its own time (plan §6.11).
    this.events.emit(DomainEvents.StreamStarted, {
      streamId: stream.id,
      hostId,
      title: stream.title,
    } satisfies StreamStartedPayload);

    return { stream, rtcToken, serverTime: new Date() };
  }

  // Most-watched first, so a newcomer lands on the busiest rooms; ties keep
  // the newest live first. [requesterId] is required when feed='following'.
  async listLive(query: ListStreamsQueryDto, requesterId?: string) {
    let followedHostIds: string[] | undefined;
    if (query.feed === 'following') {
      if (!requesterId) throw new UnauthorizedException('Sign in to see who you follow');
      const follows = await this.prisma.follow.findMany({
        where: { followerId: requesterId },
        select: { followeeId: true },
      });
      followedHostIds = follows.map((follow) => follow.followeeId);
    }
    // Blocked either way (plan §6.4): hides their lives from discovery/feeds.
    const blockedHostIds = requesterId ? await this.social.blockedEitherWayUserIds(requesterId) : [];
    // Both conditions key on `hostId` - they must merge into one filter object,
    // or spreading two separate `{ hostId: ... }` objects would let the second
    // silently overwrite the first.
    const hostIdFilter = followedHostIds
      ? { in: followedHostIds, ...(blockedHostIds.length > 0 ? { notIn: blockedHostIds } : {}) }
      : blockedHostIds.length > 0
        ? { notIn: blockedHostIds }
        : undefined;

    const lives = await this.prisma.stream.findMany({
      where: {
        status: StreamStatus.LIVE,
        ...(hostIdFilter && { hostId: hostIdFilter }),
        ...(query.category && {
          category: { equals: query.category, mode: 'insensitive' as const },
        }),
      },
      select: STREAM_LIST_SELECT,
      orderBy: { startedAt: 'desc' },
      take: MAX_RANKED_LIVES,
    });

    const ids = lives.map((live) => live.id);
    const [counts, paused] = await Promise.all([
      this.presence.viewerCounts(ids).catch((error) => {
        this.logger.warn(`Viewer counts unavailable, listing by start time: ${error}`);
        return new Map<string, number>();
      }),
      this.presence.pausedLives(ids).catch(() => new Set<string>()),
    ]);
    const ranked = lives
      .map((live) => ({
        ...live,
        viewerCount: counts.get(live.id) ?? 0,
        paused: paused.has(live.id),
      }))
      .sort((a, b) => b.viewerCount - a.viewerCount);

    const start = (query.page - 1) * query.limit;
    return {
      items: ranked.slice(start, start + query.limit),
      total: ranked.length,
      page: query.page,
      limit: query.limit,
    };
  }

  /** One stream's public state, live or not - for share links and the "LIVE has ended" screen. */
  async getPublic(streamId: string) {
    const stream = await this.prisma.stream.findUnique({
      where: { id: streamId },
      select: STREAM_DETAIL_SELECT,
    });
    if (!stream) {
      throw new NotFoundException('Stream not found');
    }
    // A live's counters are in Redis; an ended one's were saved on its row.
    const [viewerCount, paused, likeCount] =
      stream.status === StreamStatus.LIVE
        ? await Promise.all([
            this.presence.viewerCount(streamId),
            this.presence.isPaused(streamId),
            this.presence.likeCount(streamId),
          ])
        : [0, false, stream.likeCount];
    return { ...stream, viewerCount, paused, likeCount, serverTime: new Date() };
  }

  /** For the realtime gateway: the live's host and layout, or null once it's over. */
  async findLive(streamId: string) {
    return this.prisma.stream.findFirst({
      where: { id: streamId, status: StreamStatus.LIVE },
      select: { id: true, hostId: true, layout: true },
    });
  }

  async join(streamId: string, viewerId: string) {
    const stream = await this.getLiveOrThrow(streamId);
    await this.assertNotBlocked(stream.hostId, viewerId);
    if (await this.roomBans.isBanned(stream.hostId, viewerId, streamId)) {
      throw new ForbiddenException('You are banned from this stream');
    }
    // Joining as audience means this user isn't publishing: a seat still held
    // (app killed while on stage) would otherwise be a frozen tile for everyone.
    await this.vacateGuestSeat(stream, viewerId, false, viewerId);
    // A live keeps the vendor it started on, whatever VIDEO_PROVIDER is now.
    const [rtcToken, isFollowingHost, grant, pinnedMessage, activeGuests, selfGuestRequest, canRecord] =
      await Promise.all([
        this.videoProviders.get(stream.videoProvider).mintToken({
          channelName: stream.channelName,
          userId: viewerId,
          role: 'audience',
        }),
        this.social.isFollowing(viewerId, stream.hostId),
        this.moderators.findActiveGrant(streamId, viewerId),
        this.findPinnedMessage(stream.pinnedMessageId),
        this.guests.activeGuests(streamId),
        this.guests.findOwnPending(streamId, viewerId),
        this.recordingPermissions.isAllowed(streamId, viewerId),
      ]);
    return {
      stream,
      rtcToken,
      isFollowingHost,
      // This viewer's own capabilities for THIS stream (plan §6.9, revised
      // 2026-09-26: a grant is scoped to one stream, not the host's whole
      // channel) - lets the app show the right chat/ban actions from the
      // moment it joins, without waiting for a moderator.updated push that
      // may never come again this session.
      selfCapabilities: grant?.capabilities ?? [],
      pinnedMessage,
      // Who's already on stage (plan §6.5/§6.6) - a viewer who joins after
      // guests are already up still needs to render their tiles, same
      // reasoning as pinnedMessage above.
      activeGuests,
      // A pending invite lets a viewer arriving from a GUEST_INVITE
      // notification answer it; a pending request restores the raised hand.
      selfGuestRequest,
      // The app keeps the live out of screen recordings unless the host allowed this viewer.
      canRecord,
      // Meaningless (but harmless) for a LiveKit stream, where a client
      // instead correlates the host by identity=userId directly - lets an
      // Agora viewer tell the host's video tile apart from a guest's.
      hostAgoraUid: agoraUidFor(stream.hostId),
      serverTime: new Date(),
    };
  }

  /**
   * The share page's player (docs/features/share.md): anyone may watch, an
   * account or not. Video goes to a fresh anonymous identity - never the
   * account's own, which may be in the app too (Agora allows one connection
   * per uid) - and the ticket lets its socket follow the live's public
   * updates. A signed-in viewer's bans still apply.
   */
  async watch(streamId: string, userId?: string) {
    const stream = await this.getLiveOrThrow(streamId);
    if (userId) await this.assertNotBlocked(stream.hostId, userId);
    if (userId && (await this.roomBans.isBanned(stream.hostId, userId, streamId))) {
      throw new ForbiddenException('You are banned from this stream');
    }
    const { viewerId, ticket } = await this.watchTickets.issue(streamId);
    const [rtcToken, isFollowingHost, pinnedMessage, activeGuests] = await Promise.all([
      this.videoProviders.get(stream.videoProvider).mintToken({
        channelName: stream.channelName,
        userId: viewerId,
        role: 'audience',
      }),
      userId ? this.social.isFollowing(userId, stream.hostId) : false,
      this.findPinnedMessage(stream.pinnedMessageId),
      this.guests.activeGuests(streamId),
    ]);
    return {
      stream,
      rtcToken,
      watchTicket: ticket,
      isFollowingHost,
      pinnedMessage,
      activeGuests,
      hostAgoraUid: agoraUidFor(stream.hostId),
      serverTime: new Date(),
    };
  }

  // A lightweight snapshot (not the full ChatMessageView - ChatService can't
  // be injected here, StreamsModule<-ChatModule would cycle) just for the
  // pinned-message banner on join; live pin/unpin events carry their own.
  private async findPinnedMessage(
    pinnedMessageId: string | null,
  ): Promise<{ id: string; text: string; senderName: string } | null> {
    if (!pinnedMessageId) return null;
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: pinnedMessageId },
      select: { id: true, text: true, imageUrl: true, user: { select: { displayName: true } } },
    });
    return (
      message && {
        id: message.id,
        text: chatPreviewText(message.text, message.imageUrl),
        senderName: message.user.displayName,
      }
    );
  }

  async end(streamId: string, requesterId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!this.permissions.canStartOrEndStream(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can end this stream');
    }

    return this.endStream(streamId, StreamEndReason.HOST_ENDED);
  }

  /**
   * Ends every live whose host's app stopped sending heartbeats for the grace
   * window - a crash, a force-quit, lost signal. Returns how many it ended.
   */
  async endAbandonedLives(now = new Date()): Promise<number> {
    // Younger lives are still inside the grace window go-live started.
    const graceStart = new Date(now.getTime() - HOST_HEARTBEAT_TTL_SECONDS * 1000);
    const candidates = await this.prisma.stream.findMany({
      where: { status: StreamStatus.LIVE, startedAt: { lt: graceStart } },
      select: { id: true },
    });
    if (candidates.length === 0) return 0;

    const connected = await this.presence.connectedHosts(candidates.map((live) => live.id));
    const abandoned = candidates.filter((live) => !connected.has(live.id));
    for (const live of abandoned) {
      await this.endStream(live.id, StreamEndReason.HOST_DISCONNECTED);
    }
    return abandoned.length;
  }

  // Viewers already in the room follow via the stream.layout_changed event;
  // late joiners get the current layout in the join response.
  async updateLayout(streamId: string, requesterId: string, layout: StreamLayout) {
    const stream = await this.getLiveOrThrow(streamId);
    if (!this.permissions.canEditStreamDetails(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can change the stream layout');
    }
    if (stream.layout === layout) {
      return stream;
    }

    const updated = await this.prisma.stream.update({
      where: { id: streamId },
      data: { layout },
    });

    this.events.emit(DomainEvents.StreamLayoutChanged, {
      streamId,
      layout,
    } satisfies StreamLayoutChangedPayload);

    return updated;
  }

  /** Host, or a moderator holding `BAN_USERS` (plan §6.4/§6.9), force-disconnects a participant. */
  async banFromRoom(streamId: string, requesterId: string, targetUserId: string, scope: RoomBanScope) {
    const stream = await this.getOrThrow(streamId);
    if (!(await this.canUseCapability(requesterId, streamId, stream.hostId, ModeratorCapability.BAN_USERS))) {
      throw new ForbiddenException('Only the host or a moderator can ban a participant');
    }
    if (targetUserId === stream.hostId) throw new BadRequestException("The host can't be banned from their own live");
    if (targetUserId === requesterId) throw new BadRequestException("You can't ban yourself");
    await this.assertCanModerateTarget(streamId, stream.hostId, requesterId, targetUserId);
    return this.roomBans.ban(stream.hostId, targetUserId, scope, streamId, requesterId);
  }

  async unbanFromRoom(streamId: string, requesterId: string, targetUserId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!(await this.canUseCapability(requesterId, streamId, stream.hostId, ModeratorCapability.BAN_USERS))) {
      throw new ForbiddenException('Only the host or a moderator can lift a ban');
    }
    await this.assertCanModerateTarget(streamId, stream.hostId, requesterId, targetUserId);
    return this.roomBans.unban(stream.hostId, targetUserId, streamId, requesterId);
  }

  /**
   * Room chat mute (plan §6.7) - the host or a MUTE_CHAT moderator, on anyone
   * but the host and themselves. No `durationSeconds`: until the live ends.
   * The muted person still watches, likes and reads chat.
   */
  async muteChat(streamId: string, requesterId: string, targetUserId: string, durationSeconds?: number) {
    const stream = await this.getLiveOrThrow(streamId);
    if (!(await this.canUseCapability(requesterId, streamId, stream.hostId, ModeratorCapability.MUTE_CHAT))) {
      throw new ForbiddenException('Only the host or a moderator can mute someone in chat');
    }
    if (targetUserId === stream.hostId) throw new BadRequestException("The host can't be muted");
    if (targetUserId === requesterId) throw new BadRequestException("You can't mute yourself");
    await this.assertCanModerateTarget(streamId, stream.hostId, requesterId, targetUserId);
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!target) throw new NotFoundException('User not found');

    const mutedUntil = durationSeconds ? new Date(Date.now() + durationSeconds * 1000) : null;
    await this.roomChatMutes.mute(streamId, targetUserId, requesterId, mutedUntil);
    return { ok: true, mutedUntil };
  }

  async unmuteChat(streamId: string, requesterId: string, targetUserId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!(await this.canUseCapability(requesterId, streamId, stream.hostId, ModeratorCapability.MUTE_CHAT))) {
      throw new ForbiddenException('Only the host or a moderator can unmute someone in chat');
    }
    await this.assertCanModerateTarget(streamId, stream.hostId, requesterId, targetUserId);
    await this.roomChatMutes.unmute(streamId, targetUserId, requesterId);
    return { ok: true };
  }

  /** Who's muted in this live's chat right now - for the people allowed to lift it. */
  async listChatMutes(streamId: string, requesterId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!(await this.canUseCapability(requesterId, streamId, stream.hostId, ModeratorCapability.MUTE_CHAT))) {
      throw new ForbiddenException('Only the host or a moderator can see who is muted');
    }
    return this.roomChatMutes.listActive(streamId);
  }

  /**
   * The host lets one viewer record this live (screen recording and
   * screenshots in the app) - until they take it back or the live ends.
   */
  async allowRecording(streamId: string, requesterId: string, targetUserId: string) {
    const stream = await this.getLiveOrThrow(streamId);
    if (!this.permissions.isHost(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can allow recording');
    }
    if (targetUserId === stream.hostId) throw new BadRequestException('The host can always record their own live');
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!target) throw new NotFoundException('User not found');
    await this.recordingPermissions.allow(streamId, targetUserId, requesterId);
    return { ok: true };
  }

  async disallowRecording(streamId: string, requesterId: string, targetUserId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!this.permissions.isHost(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can stop someone recording');
    }
    await this.recordingPermissions.disallow(streamId, targetUserId, requesterId);
    return { ok: true };
  }

  /** Who the host has allowed to record this live. */
  async listRecordingPermissions(streamId: string, requesterId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!this.permissions.isHost(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can see who may record');
    }
    return this.recordingPermissions.list(streamId);
  }

  /** Every active moderator for this one stream - host-only, mirrors the plan's "who moderates my stream" list. */
  async listModerators(streamId: string, requesterId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!this.permissions.canManageModerators(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can view this stream\'s moderators');
    }
    return this.moderators.list(streamId);
  }

  /**
   * Appoints a moderator for THIS stream only (plan §6.9, revised
   * 2026-09-26) - it does not carry over once this stream ends; the host
   * re-grants for their next stream if they want the same person again.
   * Only the host can grant - a moderator can't appoint another moderator.
   */
  async grantModerator(streamId: string, requesterId: string, userId: string, capabilities: ModeratorCapability[]) {
    // Must be live: appointing a moderator "for today's stream" needs a today's stream.
    const stream = await this.getLiveOrThrow(streamId);
    if (!this.permissions.canManageModerators(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can appoint moderators');
    }
    return this.moderators.grant(stream.hostId, streamId, userId, capabilities);
  }

  async updateModerator(streamId: string, requesterId: string, userId: string, capabilities: ModeratorCapability[]) {
    const stream = await this.getOrThrow(streamId);
    if (!this.permissions.canManageModerators(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can edit a moderator\'s abilities');
    }
    return this.moderators.updateCapabilities(streamId, userId, capabilities);
  }

  async revokeModerator(streamId: string, requesterId: string, userId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!this.permissions.canManageModerators(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can remove a moderator');
    }
    return this.moderators.revoke(streamId, userId);
  }

  /**
   * Who's watching right now, paginated from presence (plan §6.13) - live
   * streams only, without anyone blocked either way with [requesterId].
   */
  async listViewers(streamId: string, requesterId: string, cursor?: string, limit = 30) {
    if (!(await this.findLive(streamId))) throw new NotFoundException('Stream is not live');

    const [viewerIds, blocked] = await Promise.all([
      this.presence.viewerIds(streamId),
      this.social.blockedEitherWayUserIds(requesterId),
    ]);
    const hidden = new Set(blocked);
    const allIds = viewerIds.filter((id) => !hidden.has(id)).sort();
    const startIndex = cursor ? allIds.indexOf(cursor) + 1 : 0;
    const pageIds = allIds.slice(startIndex, startIndex + limit + 1);
    const hasMore = pageIds.length > limit;
    const ids = pageIds.slice(0, limit);

    const items = await this.participantSummaries(ids);
    return { items, hasMore, nextCursor: hasMore ? ids[ids.length - 1] : null };
  }

  /** Who these people are, in the order given; ids that aren't anyone are left out. */
  async participantSummaries(ids: string[]) {
    if (ids.length === 0) return [];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: PARTICIPANT_SELECT });
    // Prisma doesn't preserve `in` order.
    const byId = new Map(users.map((user) => [user.id, user]));
    return ids.map((id) => byId.get(id)).filter((user) => user !== undefined);
  }

  /**
   * Who an `@` in this live's chat can name: the host and whoever is
   * watching, matched on the start of their username or display name - never
   * the requester, nor anyone blocked either way. The host comes first.
   */
  async mentionSuggestions(streamId: string, requesterId: string, query = '', limit = 8) {
    const stream = await this.findLive(streamId);
    if (!stream) throw new NotFoundException('Stream is not live');

    const [viewerIds, blocked] = await Promise.all([
      this.presence.viewerIds(streamId),
      this.social.blockedEitherWayUserIds(requesterId),
    ]);
    const excluded = new Set([requesterId, stream.hostId, ...blocked]);
    const q = query.trim();
    const match: Prisma.UserWhereInput = {
      status: UserStatus.ACTIVE,
      ...(q
        ? {
            OR: [
              { username: { startsWith: q, mode: 'insensitive' } },
              { displayName: { startsWith: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const select = PARTICIPANT_SELECT;
    const hostIsCandidate = stream.hostId !== requesterId && !blocked.includes(stream.hostId);
    const [host, watching] = await Promise.all([
      hostIsCandidate ? this.prisma.user.findFirst({ where: { id: stream.hostId, ...match }, select }) : null,
      this.prisma.user.findMany({
        where: { id: { in: viewerIds.filter((id) => !excluded.has(id)) }, ...match },
        orderBy: { username: 'asc' },
        take: limit,
        select,
      }),
    ]);
    return { items: [...(host ? [host] : []), ...watching].slice(0, limit) };
  }

  /** Viewer raises their hand to join on stage (plan §6.5) - live streams only, not banned, not already a guest. */
  async requestToJoinAsGuest(streamId: string, viewerId: string) {
    const stream = await this.getLiveOrThrow(streamId);
    await this.assertNotBlocked(stream.hostId, viewerId);
    if (await this.roomBans.isBanned(stream.hostId, viewerId, streamId)) {
      throw new ForbiddenException('You are banned from this stream');
    }
    return this.guests.request(streamId, stream.hostId, viewerId);
  }

  /** The host picks someone to invite on stage - the reverse direction (plan §6.5), host-only. */
  async inviteGuest(streamId: string, requesterId: string, userId: string) {
    const stream = await this.getLiveOrThrow(streamId);
    if (!this.permissions.canStartOrEndStream(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can invite someone on stage');
    }
    await this.assertNotBlocked(stream.hostId, userId);
    return this.guests.invite(streamId, stream.hostId, userId);
  }

  /** The requester withdraws their own request, or the host retracts their own invite. */
  async cancelGuestRequest(streamId: string, requestId: string, requesterId: string) {
    const stream = await this.getOrThrow(streamId);
    return this.guests.cancel(streamId, requestId, requesterId, stream.hostId);
  }

  /** Pending requests awaiting a decision - host or a MANAGE_GUEST_REQUESTS moderator only. */
  async listGuestRequests(streamId: string, requesterId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!(await this.canUseCapability(requesterId, streamId, stream.hostId, ModeratorCapability.MANAGE_GUEST_REQUESTS))) {
      throw new ForbiddenException('Only the host or a moderator can view guest requests');
    }
    return this.guests.listPending(streamId);
  }

  /** Everyone currently on stage (plan §6.6) - lets a reconnecting client refresh its tiles without rejoining. */
  async listActiveGuests(streamId: string) {
    if (!(await this.findLive(streamId))) throw new NotFoundException('Stream is not live');
    return { items: await this.guests.activeGuests(streamId) };
  }

  /**
   * Accepts either direction: the host/a moderator accepting a viewer's
   * raised hand, or the invitee accepting the host's own invite (plan
   * §6.5) - mints a fresh publisher token either way, on whichever vendor
   * this stream started on.
   */
  async acceptGuestRequest(streamId: string, requestId: string, requesterId: string) {
    const stream = await this.getLiveOrThrow(streamId);
    const request = await this.guests.findPendingOrThrow(streamId, requestId);
    await this.assertCanResolve(request, streamId, stream.hostId, requesterId);

    const activeCount = await this.guests.countActiveGuests(streamId);
    if (activeCount >= MAX_ACTIVE_GUESTS) {
      throw new ForbiddenException(`This stream already has the maximum of ${MAX_ACTIVE_GUESTS} guests`);
    }

    const credentials = await this.videoProviders.get(stream.videoProvider).mintToken({
      channelName: stream.channelName,
      userId: request.userId,
      role: 'publisher',
    });
    await this.guests.accept(streamId, requestId, credentials);
    return { ok: true };
  }

  async rejectGuestRequest(streamId: string, requestId: string, requesterId: string) {
    const stream = await this.getOrThrow(streamId);
    const request = await this.guests.findPendingOrThrow(streamId, requestId);
    await this.assertCanResolve(request, streamId, stream.hostId, requesterId);
    return this.guests.reject(streamId, requestId);
  }

  /** Host- or moderator-initiated (needs `REMOVE_GUESTS`) - sets the re-request cooldown (plan §6.6). */
  async removeGuest(streamId: string, requesterId: string, targetUserId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!(await this.canUseCapability(requesterId, streamId, stream.hostId, ModeratorCapability.REMOVE_GUESTS))) {
      throw new ForbiddenException('Only the host or a moderator can remove a guest');
    }
    await this.assertCanModerateTarget(streamId, stream.hostId, requesterId, targetUserId);
    await this.vacateGuestSeat(stream, targetUserId, true, requesterId);
    return { ok: true };
  }

  /** Guest taps "Leave seat" themselves - no cooldown, they can request again right away (plan §6.6). */
  async leaveGuestSeat(streamId: string, userId: string) {
    const stream = await this.getOrThrow(streamId);
    await this.vacateGuestSeat(stream, userId, false, userId);
    return { ok: true };
  }

  /**
   * Turns a guest's mic off and keeps it off (plan §6.7), or lets them turn
   * it back on - host or a FORCE_MUTE_GUESTS moderator; a moderator may also
   * lift the lock on their own mic. A guest who gets round it can still be
   * removed; nobody's mic is ever turned on remotely.
   */
  async setGuestMicForceMuted(streamId: string, requesterId: string, targetUserId: string, forceMuted: boolean) {
    const stream = await this.getLiveOrThrow(streamId);
    const liftingOwnLock =
      !forceMuted &&
      requesterId === targetUserId &&
      this.permissions.canLiftOwnMicLock(
        requesterId,
        targetUserId,
        await this.moderators.isActiveModerator(streamId, requesterId),
      );
    if (!liftingOwnLock) {
      if (!(await this.canUseCapability(requesterId, streamId, stream.hostId, ModeratorCapability.FORCE_MUTE_GUESTS))) {
        throw new ForbiddenException("Only the host or a moderator can control a guest's mic");
      }
      await this.assertCanModerateTarget(streamId, stream.hostId, requesterId, targetUserId);
    }
    await this.guests.setMicForceMuted(streamId, targetUserId, requesterId, forceMuted);
    return { ok: true };
  }

  /**
   * The host's post-live numbers (plan §6.13): how long it ran, peak viewers,
   * likes, and how many people followed them during it. Still answers while
   * live (counts from presence), so the ending screen never races the end.
   */
  async summary(streamId: string, requesterId: string) {
    const stream = await this.getOrThrow(streamId);
    if (!this.permissions.canStartOrEndStream(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can see this summary');
    }
    const isLive = stream.status === StreamStatus.LIVE;
    const until = stream.endedAt ?? new Date();
    const [peakViewerCount, likeCount, newFollowers] = await Promise.all([
      isLive ? this.presence.peakViewerCount(streamId).catch(() => stream.peakViewerCount) : stream.peakViewerCount,
      isLive ? this.presence.likeCount(streamId).catch(() => stream.likeCount) : stream.likeCount,
      // Someone who followed and unfollowed again during the live isn't counted.
      this.prisma.follow.count({
        where: { followeeId: stream.hostId, createdAt: { gte: stream.startedAt, lte: until } },
      }),
    ]);
    return {
      streamId,
      durationSeconds: Math.max(0, Math.round((until.getTime() - stream.startedAt.getTime()) / 1000)),
      peakViewerCount,
      likeCount,
      newFollowers,
    };
  }

  /**
   * A block between a running live's host and someone in it (plan §6.4):
   * they're out of it at once - off stage and out of the video room - and the
   * gateway takes their sockets out of its room.
   */
  @OnEvent(DomainEvents.UserBlocked)
  async handleUserBlocked({ blockerId, blockedId }: UserBlockedPayload): Promise<void> {
    try {
      const lives = await this.prisma.stream.findMany({
        where: { status: StreamStatus.LIVE, hostId: { in: [blockerId, blockedId] } },
      });
      for (const stream of lives) {
        const removedByHost = stream.hostId === blockerId;
        const userId = removedByHost ? blockedId : blockerId;
        await this.vacateGuestSeat(stream, userId, removedByHost, blockerId);
        // A plain viewer has no seat, but still has the video.
        await this.videoProviders
          .get(stream.videoProvider)
          .revokeToken(stream.channelName, userId)
          .catch((error) => this.logger.warn(`Could not revoke token for ${userId} on ${stream.id}: ${error}`));
        this.events.emit(DomainEvents.LiveAccessRevoked, {
          streamId: stream.id,
          hostId: stream.hostId,
          userId,
          removedByHost,
        } satisfies LiveAccessRevokedPayload);
      }
    } catch (error) {
      this.logger.warn(`Could not apply ${blockerId}'s block of ${blockedId} to their lives: ${error}`);
    }
  }

  // Media first, then the seat: once `guest:removed` goes out the client may
  // reconnect as a viewer, and a late LiveKit revoke would kick that too.
  // Nobody seated means nothing to revoke - never kick a plain viewer.
  private async vacateGuestSeat(
    stream: Stream,
    userId: string,
    removedByHostOrModerator: boolean,
    actorId: string,
  ): Promise<void> {
    if (!(await this.guests.isActiveGuest(stream.id, userId))) return;
    await this.videoProviders
      .get(stream.videoProvider)
      .revokeToken(stream.channelName, userId)
      .catch((error) => this.logger.warn(`Could not revoke token for ${userId} on ${stream.id}: ${error}`));
    await this.guests.remove(stream.id, stream.hostId, userId, removedByHostOrModerator, actorId);
  }

  // A VIEWER-initiated request/accept/reject is a host-or-moderator action;
  // a HOST-initiated invite is the invitee's own call - same routes, the
  // direction on the row itself decides which check applies (plan §6.5).
  private async assertCanResolve(
    request: { initiatedBy: GuestRequestInitiator; userId: string },
    streamId: string,
    hostId: string,
    requesterId: string,
  ): Promise<void> {
    if (request.initiatedBy === GuestRequestInitiator.HOST) {
      if (request.userId !== requesterId) {
        throw new ForbiddenException('Only the invited user can respond to this invite');
      }
      return;
    }
    if (!(await this.canUseCapability(requesterId, streamId, hostId, ModeratorCapability.MANAGE_GUEST_REQUESTS))) {
      throw new ForbiddenException('Only the host or a moderator can respond to a guest request');
    }
  }

  // Skips the grant lookup entirely for the host, who always passes. A
  // grant only ever applies to the one stream it was made for (plan §6.9).
  private async canUseCapability(
    requesterId: string,
    streamId: string,
    hostId: string,
    capability: ModeratorCapability,
  ): Promise<boolean> {
    if (this.permissions.isHost(requesterId, hostId)) return true;
    const grant = await this.moderators.findActiveGrant(streamId, requesterId);
    return this.permissions.hasChannelCapability(requesterId, hostId, grant, capability);
  }

  // Only the host acts on a moderator, and nobody on the host (plan §6.9).
  // The grant lookup is skipped whenever the answer can't depend on it.
  private async assertCanModerateTarget(
    streamId: string,
    hostId: string,
    requesterId: string,
    targetUserId: string,
  ): Promise<void> {
    const dependsOnGrant = !this.permissions.isHost(requesterId, hostId) && targetUserId !== requesterId && targetUserId !== hostId;
    const targetIsModerator = dependsOnGrant && (await this.moderators.isActiveModerator(streamId, targetUserId));
    switch (this.permissions.moderationTargetRefusal(requesterId, hostId, targetUserId, targetIsModerator)) {
      case 'TARGET_IS_HOST':
        throw new ForbiddenException({ message: "You can't do that to the host", code: 'TARGET_IS_HOST' });
      case 'TARGET_IS_MODERATOR':
        throw new ForbiddenException({ message: 'Only the host can do that to a moderator', code: 'TARGET_IS_MODERATOR' });
    }
  }

  private async endStream(streamId: string, reason: StreamEndReason) {
    return (await this.closeStream(streamId, reason)).stream;
  }

  /**
   * The admin kill switch (plan §6.8): everyone in the live is told why and
   * the live ends at once - media closed, guests off stage. The host can go
   * live again unless they're also suspended, which is a separate action.
   */
  async lock(streamId: string, actorId: string, reason: string) {
    const stream = await this.getOrThrow(streamId);
    if (stream.status !== StreamStatus.LIVE) throw new ConflictException('Only a live that is running can be locked');
    const { stream: locked, changed } = await this.closeStream(streamId, StreamEndReason.LOCKED, { actorId, reason });
    if (!changed) throw new ConflictException('This live has already ended');
    return locked;
  }

  /** Clears the lock flag after review - the live stays over (plan §6.8). */
  async unlock(streamId: string, actorId: string) {
    const { count } = await this.prisma.stream.updateMany({
      where: { id: streamId, status: StreamStatus.LOCKED },
      data: { status: StreamStatus.ENDED },
    });
    if (count === 0) {
      await this.getOrThrow(streamId);
      throw new ConflictException('This live is not locked');
    }
    const stream = await this.getOrThrow(streamId);
    this.events.emit(DomainEvents.StreamUnlocked, {
      streamId,
      actorId,
      hostId: stream.hostId,
    } satisfies StreamUnlockedPayload);
    return stream;
  }

  /** A suspended host's running lives are locked as well, so nobody is left watching. */
  async lockLiveStreamsOfHost(hostId: string, actorId: string, reason: string): Promise<number> {
    const lives = await this.prisma.stream.findMany({
      where: { hostId, status: StreamStatus.LIVE },
      select: { id: true },
    });
    let locked = 0;
    for (const live of lives) {
      if ((await this.closeStream(live.id, StreamEndReason.LOCKED, { actorId, reason })).changed) locked++;
    }
    return locked;
  }

  private async closeStream(streamId: string, reason: StreamEndReason, lock?: { actorId: string; reason: string }) {
    const [peakViewerCount, likeCount] = await Promise.all([
      this.presence.peakViewerCount(streamId).catch(() => 0),
      this.presence.likeCount(streamId).catch(() => 0),
    ]);
    const now = new Date();
    // Conditional, so when the host's "End" and the sweeper race only one
    // of them ends the live and announces it.
    const { count } = await this.prisma.stream.updateMany({
      where: { id: streamId, status: StreamStatus.LIVE },
      data: {
        status: lock ? StreamStatus.LOCKED : StreamStatus.ENDED,
        endedAt: now,
        endedReason: reason,
        peakViewerCount,
        likeCount,
        ...(lock ? { lockedById: lock.actorId, lockedReason: lock.reason, lockedAt: now } : {}),
      },
    });
    const stream = await this.getOrThrow(streamId);
    if (count === 0) return { stream, changed: false };

    // Decoupled from the realtime gateway on purpose - see docs/features/events.md.
    // A lock goes out first: ending the live empties its room.
    if (lock) {
      this.events.emit(DomainEvents.StreamLocked, {
        streamId,
        hostId: stream.hostId,
        actorId: lock.actorId,
        reason: lock.reason,
      } satisfies StreamLockedPayload);
    }
    this.events.emit(DomainEvents.StreamEnded, {
      streamId,
      reason,
      ...(lock ? { message: lock.reason } : {}),
    } satisfies StreamEndedPayload);

    void this.presence
      .clear(streamId)
      .catch((error) => this.logger.warn(`Could not clear presence of ${streamId}: ${error}`));
    // Every active guest becomes removed (plan §6.6) - pure data cleanup, not
    // awaited: stream_ended already tears down every guest's connection too.
    void this.guests
      .removeAllForEndedStream(streamId)
      .catch((error) => this.logger.warn(`Could not clear guests of ${streamId}: ${error}`));
    // Not awaited: the live is already over for everyone, so a slow or
    // unreachable media server mustn't hold up the host's "End stream".
    void this.closeChannel(stream);

    return { stream, changed: true };
  }

  private async closeChannel(stream: Stream) {
    try {
      await this.videoProviders.get(stream.videoProvider).closeChannel(stream.channelName);
    } catch (error) {
      // An abandoned LiveKit room still closes by itself (departure timeout).
      this.logger.warn(`Could not close channel ${stream.channelName}: ${error}`);
    }
  }

  private async getOrThrow(streamId: string) {
    const stream = await this.prisma.stream.findUnique({ where: { id: streamId } });
    if (!stream) {
      throw new NotFoundException('Stream not found');
    }
    return stream;
  }

  // Blocked either way (plan §6.4): to them the live doesn't exist - without
  // saying which side blocked.
  private async assertNotBlocked(hostId: string, userId: string): Promise<void> {
    if (await this.social.isBlockedEitherWay(hostId, userId)) {
      throw new NotFoundException('Stream not found');
    }
  }

  private async getLiveOrThrow(streamId: string) {
    const stream = await this.prisma.stream.findUnique({
      where: { id: streamId },
      include: { host: HOST_PUBLIC_SELECT },
    });
    if (!stream) {
      throw new NotFoundException('Stream not found');
    }
    if (stream.status !== StreamStatus.LIVE) {
      throw new NotFoundException('Stream is not live');
    }
    return stream;
  }
}
