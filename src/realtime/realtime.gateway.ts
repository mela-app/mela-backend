import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { AlertScope, RoomBanScope, StreamLayout } from '@prisma/client';
import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { AccessTokenClaims } from '../auth/auth.types';
import { WatchTicketService } from '../auth/watch-ticket.service';
import { ChatMessageView, ChatSendError, ChatService } from '../chat/chat.service';
import { ChatDeleteDto, ChatSendDto, LikeSendDto } from '../chat/dto/chat-events.dto';
import { LikesService } from '../chat/likes.service';
import {
  DomainEvents,
  AdminAlertSentPayload,
  ChatMessageDeletedPayload,
  ChatMessagePinnedPayload,
  ChatMessageUnpinnedPayload,
  DirectMessageSentPayload,
  DirectMessagesReadPayload,
  GuestJoinedPayload,
  GuestMicForceMuteChangedPayload,
  GuestRemovedPayload,
  GuestRequestAcceptedPayload,
  GuestRequestCancelledPayload,
  GuestRequestCreatedPayload,
  GuestRequestRejectedPayload,
  LiveAccessRevokedPayload,
  ModeratorGrantedPayload,
  ModeratorRevokedPayload,
  ModeratorUpdatedPayload,
  NotificationCreatedPayload,
  RecordingPermissionChangedPayload,
  RoomBanCreatedPayload,
  RoomChatMuteChangedPayload,
  StreamEndedPayload,
  StreamLayoutChangedPayload,
  StreamLockedPayload,
  StreamUnlockedPayload,
  UserSessionsRevokedPayload,
  UserSuspendedPayload,
} from '../common/events/domain-events';
import { LivePresenceService } from '../common/presence/live-presence.service';
import { KeyedThrottle } from '../common/throttle/keyed-throttle';
import { ModeratorsService } from '../moderators/moderators.service';
import { RecordingPermissionsService } from '../recording-permissions/recording-permissions.service';
import { RoomBansService } from '../room-bans/room-bans.service';
import { RoomChatMutesService } from '../room-chat-mutes/room-chat-mutes.service';
import { SocialService } from '../social/social.service';
import { StreamsService } from '../streams/streams.service';
import { HostAwayDto, HostJoinDto, HostPauseDto, StreamRoomDto } from './dto/stream-room.dto';

const VIEWER_COUNT_THROTTLE_MS = 2000;
// Faster than viewer counts: likes should feel alive, and each update is one small number.
const LIKES_THROTTLE_MS = 1000;
// A busy live's arrivals come out as one "X and N others joined" at a time.
const ARRIVALS_THROTTLE_MS = 1500;
// What the share page's player shows of the chat so far.
const WATCH_CHAT_SNAPSHOT = 30;
// All a watch-only socket may ask; anything else is refused before any handler runs.
const WATCH_ONLY_EVENTS = new Set(['stream:watch', 'stream:leave']);

interface SocketData {
  userId: string;
  viewingStreamId?: string;
  hostingStreamId?: string;
  // Set for the share page's player without an account: the one live its ticket is for.
  watchOnly?: { streamId: string };
}

type AuthedSocket = Socket & { data: SocketData };

export type RealtimeError =
  | 'INVALID_PAYLOAD'
  | 'STREAM_NOT_LIVE'
  | 'NOT_HOST'
  | 'NOT_IN_ROOM'
  | 'NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | ChatSendError;
export interface RoomState {
  viewerCount: number;
  layout: StreamLayout;
  hostAway: boolean;
  paused: boolean;
  likeCount: number;
  // Who moderates the live: their messages carry a badge, and other moderators can't act on them.
  moderatorIds: string[];
}
// Only about the joiner themselves - resent on every join, so a reconnect
// catches up on a mute that started or lifted while they were offline.
export interface SelfRoomState {
  chatMuted: boolean;
  // While muted, null means until the live ends.
  chatMutedUntil: Date | null;
  // The host lets them record this live; otherwise the app keeps it out of recordings.
  canRecord: boolean;
}
type Failure = { ok: false; error: RealtimeError; retryAfterMs?: number };
export type Ack = { ok: true } | Failure;
export type RoomAck = ({ ok: true } & RoomState) | Failure;
export type ViewerRoomAck = ({ ok: true } & RoomState & SelfRoomState) | Failure;
export type WatchRoomAck = ({ ok: true } & RoomState & { messages: ChatMessageView[] }) | Failure;
export type ChatAck = { ok: true; message: ChatMessageView } | Failure;
export type LikeAck = { ok: true; total: number } | Failure;

/**
 * The app's one realtime connection: auth, each user's private room, stream
 * rooms with unique-viewer presence, host heartbeats, "away" and "paused"
 * state, chat and likes, and relays of stream lifecycle events. Every client
 * request is acknowledged. See docs/features/realtime.md and chat.md.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly viewerCounts = new KeyedThrottle(VIEWER_COUNT_THROTTLE_MS, (streamId) =>
    this.flushViewerCount(streamId),
  );
  private readonly likeTotals = new KeyedThrottle(LIKES_THROTTLE_MS, (streamId) =>
    this.flushLikes(streamId),
  );
  private readonly arrivals = new KeyedThrottle(ARRIVALS_THROTTLE_MS, (streamId) =>
    this.flushArrivals(streamId),
  );
  // Per live: the latest arrival not yet announced, and how many more came with them.
  private readonly pendingArrivals = new Map<string, { userId: string; others: number }>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly streams: StreamsService,
    private readonly presence: LivePresenceService,
    private readonly chat: ChatService,
    private readonly likes: LikesService,
    private readonly roomBans: RoomBansService,
    private readonly roomChatMutes: RoomChatMutesService,
    private readonly moderators: ModeratorsService,
    private readonly watchTickets: WatchTicketService,
    private readonly recordingPermissions: RecordingPermissionsService,
    private readonly social: SocialService,
  ) {}

  // Middleware runs before a connection is accepted, so no event can arrive
  // from a socket that hasn't been authenticated yet.
  afterInit(server: Server) {
    server.use((socket, next) => {
      this.authenticate(socket as AuthedSocket).then(
        () => next(),
        () => next(new Error('unauthorized')),
      );
    });
  }

  handleConnection(socket: AuthedSocket) {
    if (socket.data.watchOnly) {
      socket.use(([event, ...args], next) => {
        if (WATCH_ONLY_EVENTS.has(event)) return next();
        const ack: unknown = args[args.length - 1];
        if (typeof ack === 'function') ack(fail('NOT_ALLOWED'));
      });
      return;
    }
    // Private channel: forced sign-out now, notifications and moderator grants later.
    void socket.join(userRoom(socket.data.userId));
  }

  // A host's heartbeat just stops; the sweeper gives them the grace window to come back.
  async handleDisconnect(socket: AuthedSocket) {
    try {
      await this.leaveViewing(socket);
    } catch (error) {
      this.logger.warn(`Could not remove ${socket.id} from its live: ${error}`);
    }
  }

  @SubscribeMessage('stream:join')
  async onStreamJoin(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<ViewerRoomAck> {
    const request = await parse(StreamRoomDto, body);
    if (!request) return fail('INVALID_PAYLOAD');
    const live = await this.streams.findLive(request.streamId);
    if (!live) return fail('STREAM_NOT_LIVE');
    if (await this.roomBans.isBanned(live.hostId, socket.data.userId, live.id)) {
      return fail('NOT_ALLOWED');
    }
    // Blocked either way with the host (plan §6.4).
    if (await this.social.isBlockedEitherWay(live.hostId, socket.data.userId)) {
      return fail('NOT_ALLOWED');
    }

    // One live per socket: switching lives leaves the previous one.
    if (socket.data.viewingStreamId !== live.id) {
      await this.leaveViewing(socket);
      socket.data.viewingStreamId = live.id;
      await socket.join(streamRoom(live.id));
    }
    // The host watching from another device isn't one of their own viewers.
    if (live.hostId !== socket.data.userId) {
      const { arrived } = await this.presence.addViewer(live.id, socket.data.userId, socket.id);
      this.viewerCounts.schedule(live.id);
      if (arrived) void this.announceArrival(live.id, socket.data.userId);
    }
    const [state, chatMute, canRecord] = await Promise.all([
      this.roomState(live.id, live.layout),
      this.roomChatMutes.findActive(live.id, socket.data.userId),
      this.recordingPermissions.isAllowed(live.id, socket.data.userId),
    ]);
    return {
      ok: true,
      ...state,
      chatMuted: chatMute !== null,
      chatMutedUntil: chatMute?.expiresAt ?? null,
      canRecord,
    };
  }

  @SubscribeMessage('stream:leave')
  async onStreamLeave(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const request = await parse(StreamRoomDto, body);
    if (!request) return fail('INVALID_PAYLOAD');
    if (socket.data.viewingStreamId === request.streamId) await this.leaveViewing(socket);
    return { ok: true };
  }

  // The share page's player without an account (docs/features/share.md): the
  // live's public updates and its chat so far. Counted as a viewer, never
  // announced or listed; the room carries nothing private.
  @SubscribeMessage('stream:watch')
  async onStreamWatch(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<WatchRoomAck> {
    const request = await parse(StreamRoomDto, body);
    if (!request) return fail('INVALID_PAYLOAD');
    if (socket.data.watchOnly?.streamId !== request.streamId) return fail('NOT_ALLOWED');
    const live = await this.streams.findLive(request.streamId);
    if (!live) return fail('STREAM_NOT_LIVE');
    if (socket.data.viewingStreamId !== live.id) {
      socket.data.viewingStreamId = live.id;
      await socket.join(streamRoom(live.id));
      await this.presence.addViewer(live.id, socket.data.userId, socket.id);
      this.viewerCounts.schedule(live.id);
    }
    const [state, chat] = await Promise.all([
      this.roomState(live.id, live.layout),
      this.chat.history(live.id, { limit: WATCH_CHAT_SNAPSHOT }).catch(() => ({ messages: [] })),
    ]);
    return { ok: true, ...state, messages: chat.messages };
  }

  @SubscribeMessage('stream:host_join')
  async onHostJoin(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<RoomAck> {
    const request = await parse(HostJoinDto, body);
    if (!request) return fail('INVALID_PAYLOAD');
    const live = await this.streams.findLive(request.streamId);
    if (!live) return fail('STREAM_NOT_LIVE');
    if (live.hostId !== socket.data.userId) return fail('NOT_HOST');

    socket.data.hostingStreamId = live.id;
    await socket.join(streamRoom(live.id));
    // Before the heartbeat, which gives a paused host the longer grace window.
    if (request.paused !== undefined) await this.announcePaused(live.id, request.paused);
    await this.presence.touchHost(live.id);
    await this.announceHostAway(live.id, request.away ?? false);
    return { ok: true, ...(await this.roomState(live.id, live.layout)) };
  }

  // Also how a host who was offline learns their live was ended meanwhile.
  @SubscribeMessage('stream:host_heartbeat')
  async onHostHeartbeat(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const request = await parse(StreamRoomDto, body);
    if (!request) return fail('INVALID_PAYLOAD');
    if (socket.data.hostingStreamId !== request.streamId) return fail('NOT_HOST');
    if (!(await this.isStillLive(socket, request.streamId))) return fail('STREAM_NOT_LIVE');
    await this.presence.touchHost(request.streamId);
    return { ok: true };
  }

  @SubscribeMessage('stream:host_away')
  async onHostAway(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const request = await parse(HostAwayDto, body);
    if (!request) return fail('INVALID_PAYLOAD');
    if (socket.data.hostingStreamId !== request.streamId) return fail('NOT_HOST');
    if (!request.away) {
      // Coming back is a sign of life: without it, a host returning just
      // before the grace window closes would be swept before their next beat.
      if (!(await this.isStillLive(socket, request.streamId))) return fail('STREAM_NOT_LIVE');
      await this.presence.touchHost(request.streamId);
    }
    await this.announceHostAway(request.streamId, request.away);
    return { ok: true };
  }

  // The host's app turns the camera and microphone off; viewers see a pause screen.
  @SubscribeMessage('stream:host_pause')
  async onHostPause(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const request = await parse(HostPauseDto, body);
    if (!request) return fail('INVALID_PAYLOAD');
    if (socket.data.hostingStreamId !== request.streamId) return fail('NOT_HOST');
    if (!(await this.isStillLive(socket, request.streamId))) return fail('STREAM_NOT_LIVE');
    await this.announcePaused(request.streamId, request.paused);
    // Re-arms the heartbeat with the grace window that now applies.
    await this.presence.touchHost(request.streamId);
    return { ok: true };
  }

  // Anyone in the live - viewer or host - can chat (plan §5).
  @SubscribeMessage('chat:send')
  async onChatSend(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<ChatAck> {
    const request = await parse(ChatSendDto, body);
    if (!request) return fail('INVALID_PAYLOAD');
    const room = streamRoom(request.streamId);
    // Rooms are emptied when a live ends, so this also refuses an ended live.
    if (!socket.rooms.has(room)) return fail('NOT_IN_ROOM');
    try {
      // Looked up first: a message that can't be kept from them isn't sent at all.
      const hidden = await this.blockedRoomsOf(socket.data.userId);
      const result = await this.chat.send(
        request.streamId,
        socket.data.userId,
        request.text ?? '',
        request.clientId,
        request.imageKey,
      );
      if (!result.ok) return fail(result.error, result.retryAfterMs);
      // The sender has it in this answer; everyone else, their other devices
      // included, by broadcast - but nobody blocked either way with them.
      if (!result.resent) {
        const others = socket.to(room);
        (hidden.length > 0 ? others.except(hidden) : others).emit('chat:new', result.message);
      }
      return { ok: true, message: result.message };
    } catch (error) {
      this.logger.warn(`Chat message for ${request.streamId} failed: ${error}`);
      return fail('UNAVAILABLE');
    }
  }

  @SubscribeMessage('like:send')
  async onLikeSend(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<LikeAck> {
    const request = await parse(LikeSendDto, body);
    if (!request) return fail('INVALID_PAYLOAD');
    if (!socket.rooms.has(streamRoom(request.streamId))) return fail('NOT_IN_ROOM');
    // Likes count what viewers think; a host liking their own live doesn't.
    if (socket.data.hostingStreamId === request.streamId) return fail('NOT_ALLOWED');
    try {
      const result = await this.likes.add(request.streamId, socket.data.userId, request.count);
      if (!result.ok) return fail(result.error, result.retryAfterMs);
      this.likeTotals.schedule(request.streamId);
      return { ok: true, total: result.total };
    } catch (error) {
      this.logger.warn(`Likes for ${request.streamId} failed: ${error}`);
      return fail('UNAVAILABLE');
    }
  }

  // Only the host or a delegated moderator deletes a message (plan §6.9).
  @SubscribeMessage('chat:delete')
  async onChatDelete(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const request = await parse(ChatDeleteDto, body);
    if (!request) return fail('INVALID_PAYLOAD');
    const room = streamRoom(request.streamId);
    if (!socket.rooms.has(room)) return fail('NOT_IN_ROOM');
    try {
      const result = await this.chat.delete(request.streamId, request.messageId, socket.data.userId);
      if (!result.ok) return fail(result.error);
      // Broadcast happens off the chat_message.deleted domain event, not here
      // (handleChatMessageDeleted below) - keeps every path that can delete a
      // message, socket or otherwise, in sync with what viewers see.
      return { ok: true };
    } catch (error) {
      this.logger.warn(`Chat delete for ${request.streamId} failed: ${error}`);
      return fail('UNAVAILABLE');
    }
  }

  // Emitted by StreamsService via the domain event bus - StreamsModule never
  // imports this module (plan §4.1 / docs/features/events.md).
  @OnEvent(DomainEvents.StreamEnded)
  handleStreamEnded(payload: StreamEndedPayload) {
    const room = streamRoom(payload.streamId);
    this.viewerCounts.cancel(payload.streamId);
    this.likeTotals.cancel(payload.streamId);
    this.arrivals.cancel(payload.streamId);
    this.pendingArrivals.delete(payload.streamId);
    this.server.to(room).emit('stream_ended', payload);
    this.server.in(room).socketsLeave(room);
  }

  @OnEvent(DomainEvents.StreamLayoutChanged)
  handleStreamLayoutChanged(payload: StreamLayoutChangedPayload) {
    this.server.to(streamRoom(payload.streamId)).emit('stream:layout_changed', payload);
  }

  // Their sessions are ended as well (AuthService), so reconnecting fails the handshake.
  @OnEvent(DomainEvents.UserSuspended)
  handleUserSuspended(payload: UserSuspendedPayload) {
    this.server.in(userRoom(payload.userId)).disconnectSockets(true);
  }

  @OnEvent(DomainEvents.UserSessionsRevoked)
  handleUserSessionsRevoked(payload: UserSessionsRevokedPayload) {
    this.server.in(userRoom(payload.userId)).disconnectSockets(true);
  }

  // Before stream_ended, which empties the room (plan §6.8).
  @OnEvent(DomainEvents.StreamLocked)
  handleStreamLocked(payload: StreamLockedPayload) {
    this.server
      .to(streamRoom(payload.streamId))
      .emit('stream:locked', { streamId: payload.streamId, reason: payload.reason });
  }

  // The live stays over, so its room is empty: only the host has anything to update.
  @OnEvent(DomainEvents.StreamUnlocked)
  handleStreamUnlocked(payload: StreamUnlockedPayload) {
    if (!payload.hostId) return;
    this.server.to(userRoom(payload.hostId)).emit('stream:unlocked', { streamId: payload.streamId });
  }

  @OnEvent(DomainEvents.AdminAlertSent)
  handleAdminAlertSent(payload: AdminAlertSentPayload) {
    const alert = {
      id: payload.alertId,
      scope: payload.scope,
      streamId: payload.streamId,
      message: payload.message,
      severity: payload.severity,
      createdAt: payload.createdAt,
    };
    if (payload.scope === AlertScope.STREAM && payload.streamId) {
      this.server.to(streamRoom(payload.streamId)).emit('admin:alert', alert);
    } else {
      this.server.emit('admin:alert', alert);
    }
  }

  /** Devices an alert would reach right now: every connected app, or one live's room. */
  connectedCount(streamId?: string): number {
    if (streamId) return this.server.sockets.adapter.rooms.get(streamRoom(streamId))?.size ?? 0;
    return this.server.sockets.sockets.size;
  }

  // Broadcasts for every path that can delete a message (plan §6.9) - socket, or a future REST/admin one.
  @OnEvent(DomainEvents.ChatMessageDeleted)
  handleChatMessageDeleted(payload: ChatMessageDeletedPayload) {
    this.server
      .to(streamRoom(payload.streamId))
      .emit('chat:deleted', { streamId: payload.streamId, messageId: payload.messageId });
  }

  @OnEvent(DomainEvents.ChatMessagePinned)
  handleChatMessagePinned(payload: ChatMessagePinnedPayload) {
    this.server.to(streamRoom(payload.streamId)).emit('chat:pinned', payload);
  }

  @OnEvent(DomainEvents.ChatMessageUnpinned)
  handleChatMessageUnpinned(payload: ChatMessageUnpinnedPayload) {
    this.server.to(streamRoom(payload.streamId)).emit('chat:unpinned', payload);
  }

  // What a moderator may do reaches only their own sockets, on their private
  // room. Who moderates is the room's to know (stream:moderators).
  @OnEvent(DomainEvents.ModeratorGranted)
  handleModeratorGranted(payload: ModeratorGrantedPayload) {
    this.server.to(userRoom(payload.userId)).emit('moderator:granted', payload);
    void this.announceModerators(payload.streamId);
  }

  @OnEvent(DomainEvents.ModeratorUpdated)
  handleModeratorUpdated(payload: ModeratorUpdatedPayload) {
    this.server.to(userRoom(payload.userId)).emit('moderator:updated', payload);
  }

  @OnEvent(DomainEvents.ModeratorRevoked)
  handleModeratorRevoked(payload: ModeratorRevokedPayload) {
    this.server.to(userRoom(payload.userId)).emit('moderator:revoked', payload);
    void this.announceModerators(payload.streamId);
  }

  // See NotificationCreatedPayload's doc comment for why unread_count is a
  // delta, not a recomputed total - avoids a COUNT query per fan-out recipient.
  @OnEvent(DomainEvents.NotificationCreated)
  handleNotificationCreated(payload: NotificationCreatedPayload) {
    const room = userRoom(payload.recipientId);
    this.server.to(room).emit('notification:new', payload.notification);
    this.server.to(room).emit('notification:unread_count', { delta: 1 });
  }

  // Private, to whichever recipientIds GuestsService already computed (the
  // host + eligible moderators for a viewer's raised hand, or just the
  // invitee for a host's own invite) - plan §6.5. One wire event name either
  // way; the mobile client tells them apart by `initiatedBy`.
  @OnEvent(DomainEvents.GuestRequestCreated)
  handleGuestRequestCreated(payload: GuestRequestCreatedPayload) {
    for (const recipientId of payload.recipientIds) {
      this.server.to(userRoom(recipientId)).emit('guest_request:new', payload);
    }
  }

  // Private, to the newly-accepted guest's own sockets - carries fresh
  // publish credentials so their client can start broadcasting immediately.
  @OnEvent(DomainEvents.GuestRequestAccepted)
  handleGuestRequestAccepted(payload: GuestRequestAcceptedPayload) {
    this.server.to(userRoom(payload.userId)).emit('guest_request:accepted', payload);
  }

  @OnEvent(DomainEvents.GuestRequestRejected)
  handleGuestRequestRejected(payload: GuestRequestRejectedPayload) {
    this.server.to(userRoom(payload.userId)).emit('guest_request:rejected', payload);
  }

  @OnEvent(DomainEvents.GuestRequestCancelled)
  handleGuestRequestCancelled(payload: GuestRequestCancelledPayload) {
    for (const recipientId of payload.recipientIds) {
      this.server.to(userRoom(recipientId)).emit('guest_request:cancelled', payload);
    }
  }

  // Public - every viewer's UI adds a tile (plan §6.5).
  @OnEvent(DomainEvents.GuestJoined)
  handleGuestJoined(payload: GuestJoinedPayload) {
    this.server.to(streamRoom(payload.streamId)).emit('guest:joined', payload);
  }

  // Public `guest:removed` always fires (drop the tile); the removed guest's
  // own sockets ALSO get a private `you_were_removed` - but only for a
  // host/moderator-initiated removal, not a self-initiated "leave seat"
  // (they already know - plan §6.6).
  @OnEvent(DomainEvents.GuestRemoved)
  handleGuestRemoved(payload: GuestRemovedPayload) {
    this.server.to(streamRoom(payload.streamId)).emit('guest:removed', payload);
    if (payload.wasRemovedByHostOrModerator) {
      this.server.to(userRoom(payload.userId)).emit('you_were_removed', {
        streamId: payload.streamId,
        hostId: payload.hostId,
      });
    }
  }

  // A SESSION ban's reach is exactly one running live, so evict it at the
  // transport level too, not just by notifying the client to leave. A
  // HOST_PERMANENT ban has no single room to evict from here (stream:join's
  // isBanned check keeps them out of anything of this host's from now on);
  // the notification still carries hostId so a client already watching this
  // host can leave right away instead of waiting to be refused on rejoin.
  @OnEvent(DomainEvents.RoomBanCreated)
  handleRoomBanCreated(payload: RoomBanCreatedPayload) {
    const target = userRoom(payload.bannedUserId);
    if (payload.streamId) {
      this.server.in(target).socketsLeave(streamRoom(payload.streamId));
    }
    this.server.to(target).emit('force_disconnect', {
      hostId: payload.hostId,
      streamId: payload.streamId,
      scope: payload.scope,
    });
  }

  // A block between the host and someone in their live (plan §6.4): out of
  // the room at once. Whoever the host blocked hears it as a removal from
  // this live; someone who blocked the host is leaving on their own.
  @OnEvent(DomainEvents.LiveAccessRevoked)
  handleLiveAccessRevoked(payload: LiveAccessRevokedPayload) {
    const target = userRoom(payload.userId);
    this.server.in(target).socketsLeave(streamRoom(payload.streamId));
    if (payload.removedByHost) {
      this.server.to(target).emit('force_disconnect', {
        hostId: payload.hostId,
        streamId: payload.streamId,
        scope: RoomBanScope.SESSION,
      });
    }
  }

  // Private to the muted person (plan §6.7): their composer locks until
  // mutedUntil (null: the live's end) or chat:unmuted. The room isn't told.
  @OnEvent(DomainEvents.RoomChatMuteChanged)
  handleRoomChatMuteChanged(payload: RoomChatMuteChangedPayload) {
    const room = userRoom(payload.userId);
    if (payload.muted) {
      this.server.to(room).emit('chat:muted', { streamId: payload.streamId, mutedUntil: payload.mutedUntil });
    } else {
      this.server.to(room).emit('chat:unmuted', { streamId: payload.streamId });
    }
  }

  // Public presence:audio_state, so every tile shows the mic as muted; the
  // guest also gets a private force_mute_audio telling their app to act.
  @OnEvent(DomainEvents.GuestMicForceMuteChanged)
  handleGuestMicForceMuteChanged(payload: GuestMicForceMuteChangedPayload) {
    const { streamId, userId, forceMuted } = payload;
    if (forceMuted) this.server.to(userRoom(userId)).emit('force_mute_audio', { streamId });
    this.server.to(streamRoom(streamId)).emit('presence:audio_state', { streamId, userId, forceMuted });
  }

  // Private to that viewer: their app lets recording through for this live, or blocks it again.
  @OnEvent(DomainEvents.RecordingPermissionChanged)
  handleRecordingPermissionChanged(payload: RecordingPermissionChangedPayload) {
    this.server
      .to(userRoom(payload.userId))
      .emit('recording:permission', { streamId: payload.streamId, allowed: payload.allowed });
  }

  // Private to the two people (docs/features/messages.md): the recipient's
  // inbox and badge, and the sender's other devices.
  @OnEvent(DomainEvents.DirectMessageSent)
  handleDirectMessageSent(payload: DirectMessageSentPayload) {
    const { message, sender, recipient } = payload;
    const event = { message, sender, recipient };
    this.server.to(userRoom(message.recipientId)).emit('message:new', event);
    this.server.to(userRoom(message.senderId)).emit('message:new', event);
    this.server
      .to(userRoom(message.recipientId))
      .emit('message:unread_count', { count: payload.recipientUnreadCount });
  }

  // The partner's app shows "Seen"; the reader's other devices clear the conversation and the badge.
  @OnEvent(DomainEvents.DirectMessagesRead)
  handleDirectMessagesRead(payload: DirectMessagesReadPayload) {
    const { readerId, partnerId, readAt } = payload;
    const event = { readerId, partnerId, readAt };
    this.server.to(userRoom(partnerId)).emit('message:read', event);
    this.server.to(userRoom(readerId)).emit('message:read', event);
    this.server
      .to(userRoom(readerId))
      .emit('message:unread_count', { count: payload.readerUnreadCount });
  }

  private async authenticate(socket: AuthedSocket): Promise<void> {
    // The share page's player without an account: one live's public updates, nothing else.
    const watchTicket: unknown = socket.handshake.auth?.watchTicket;
    if (typeof watchTicket === 'string') {
      const { viewerId, streamId } = await this.watchTickets.verify(watchTicket);
      socket.data.userId = viewerId;
      socket.data.watchOnly = { streamId };
      return;
    }
    const claims = await this.jwtService.verifyAsync<AccessTokenClaims>(extractToken(socket), {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
    });
    // The access token outlives a logout or a suspension; the session doesn't.
    if (!claims.sid || !(await this.auth.isSessionActive(claims.sid, claims.sub))) {
      throw new Error('Session ended');
    }
    socket.data.userId = claims.sub;
  }

  private async announceHostAway(streamId: string, away: boolean): Promise<void> {
    if (await this.presence.setHostAway(streamId, away)) {
      this.server.to(streamRoom(streamId)).emit('stream:host_status', { streamId, away });
    }
  }

  private async announcePaused(streamId: string, paused: boolean): Promise<void> {
    if (await this.presence.setPaused(streamId, paused)) {
      this.server.to(streamRoom(streamId)).emit('stream:paused', { streamId, paused });
    }
  }

  // A socket whose live ended stops being its host, so later requests answer NOT_HOST.
  private async isStillLive(socket: AuthedSocket, streamId: string): Promise<boolean> {
    if (await this.streams.findLive(streamId)) return true;
    socket.data.hostingStreamId = undefined;
    return false;
  }

  private async leaveViewing(socket: AuthedSocket): Promise<void> {
    const streamId = socket.data.viewingStreamId;
    if (!streamId) return;
    socket.data.viewingStreamId = undefined;
    // A host socket that also joined its own live as a viewer stays in the room.
    if (socket.data.hostingStreamId !== streamId) await socket.leave(streamRoom(streamId));
    await this.presence.removeViewer(streamId, socket.id);
    this.viewerCounts.schedule(streamId);
  }

  private async roomState(streamId: string, layout: StreamLayout): Promise<RoomState> {
    const [viewerCount, hostAway, paused, likeCount, moderatorIds] = await Promise.all([
      this.presence.viewerCount(streamId),
      this.presence.isHostAway(streamId),
      this.presence.isPaused(streamId),
      this.presence.likeCount(streamId),
      this.moderators.listActiveUserIds(streamId),
    ]);
    return { viewerCount, layout, hostAway, paused, likeCount, moderatorIds };
  }

  private async announceModerators(streamId: string): Promise<void> {
    try {
      const moderatorIds = await this.moderators.listActiveUserIds(streamId);
      this.server.to(streamRoom(streamId)).emit('stream:moderators', { streamId, moderatorIds });
    } catch (error) {
      this.logger.warn(`Could not announce the moderators of ${streamId}: ${error}`);
    }
  }

  // Once per person per window (claimArrivalNotice); a burst waits for the throttle.
  private async announceArrival(streamId: string, userId: string): Promise<void> {
    try {
      if (!(await this.presence.claimArrivalNotice(streamId, userId))) return;
    } catch (error) {
      this.logger.warn(`Could not note an arrival in ${streamId}: ${error}`);
      return;
    }
    const pending = this.pendingArrivals.get(streamId);
    this.pendingArrivals.set(streamId, { userId, others: pending ? pending.others + 1 : 0 });
    this.arrivals.schedule(streamId);
  }

  private flushArrivals(streamId: string): void {
    const pending = this.pendingArrivals.get(streamId);
    if (!pending) return;
    this.pendingArrivals.delete(streamId);
    Promise.all([this.streams.participantSummaries([pending.userId]), this.blockedRoomsOf(pending.userId)]).then(
      ([[user], hidden]) => {
        if (!user) return;
        const room = this.server.to(streamRoom(streamId));
        (hidden.length > 0 ? room.except(hidden) : room).emit('viewer:joined', {
          streamId,
          user,
          others: pending.others,
        });
      },
      (error) => this.logger.warn(`Could not announce an arrival in ${streamId}: ${error}`),
    );
  }

  // The personal rooms of everyone blocked either way with [userId] (plan §6.4).
  private async blockedRoomsOf(userId: string): Promise<string[]> {
    return (await this.social.blockedEitherWayUserIds(userId)).map(userRoom);
  }

  private flushViewerCount(streamId: string): void {
    this.presence.viewerCount(streamId).then(
      (count) =>
        this.server.to(streamRoom(streamId)).emit('viewer_count_update', { streamId, count }),
      (error) => this.logger.warn(`Could not read the viewer count of ${streamId}: ${error}`),
    );
  }

  private flushLikes(streamId: string): void {
    this.presence.likeCount(streamId).then(
      (total) => this.server.to(streamRoom(streamId)).emit('likes_update', { streamId, total }),
      (error) => this.logger.warn(`Could not read the likes of ${streamId}: ${error}`),
    );
  }
}

const streamRoom = (streamId: string) => `stream:${streamId}`;
const userRoom = (userId: string) => `user:${userId}`;
const fail = (error: RealtimeError, retryAfterMs?: number): Failure =>
  retryAfterMs ? { ok: false, error, retryAfterMs } : { ok: false, error };

async function parse<T extends object>(dto: ClassConstructor<T>, body: unknown): Promise<T | null> {
  if (typeof body !== 'object' || body === null) return null;
  const request = plainToInstance(dto, body);
  return (await validate(request)).length === 0 ? request : null;
}

function extractToken(socket: Socket): string {
  const authToken = socket.handshake.auth?.token as string | undefined;
  const headerToken = socket.handshake.headers.authorization?.replace('Bearer ', '');
  const token = authToken ?? headerToken;
  if (!token) {
    throw new Error('Missing token');
  }
  return token;
}
