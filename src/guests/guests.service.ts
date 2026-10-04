import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  GuestRequestInitiator,
  GuestRequestStatus,
  ModeratorCapability,
  StreamGuestStatus,
  VideoProviderKind,
} from '@prisma/client';
import {
  DomainEvents,
  GuestJoinedPayload,
  GuestMicForceMuteChangedPayload,
  GuestRemovedPayload,
  GuestRequestAcceptedPayload,
  GuestRequestCancelledPayload,
  GuestRequestCreatedPayload,
  GuestRequestRejectedPayload,
} from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { agoraUidFor } from '../common/video-provider/agora-video-provider.service';
import { VideoCredentials } from '../common/video-provider/video-provider.interface';
import { ModeratorsService } from '../moderators/moderators.service';

const PROFILE_SUMMARY_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

/** Configurable max per plan §6.5 ("e.g. 6") - a constant for now, like the other numeric limits in this codebase. */
export const MAX_ACTIVE_GUESTS = 6;
// How long after a host/moderator-initiated removal before that user can request again (plan §6.6).
const REMOVAL_COOLDOWN_SECONDS = 5 * 60;

/**
 * Guest requests and active guests - the data side of plan §6.5/§6.6.
 * Owns the `guest_requests`/`stream_guests` tables and their domain events;
 * doesn't mint or revoke video tokens itself (`StreamsService` does, the
 * same split as ModeratorsService/RoomBansService). See docs/features/guests.md.
 */
@Injectable()
export class GuestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
    private readonly moderators: ModeratorsService,
  ) {}

  async isActiveGuest(streamId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.streamGuest.findUnique({
      where: { streamId_userId: { streamId, userId } },
      select: { status: true },
    });
    return row?.status === StreamGuestStatus.ACTIVE;
  }

  async countActiveGuests(streamId: string): Promise<number> {
    return this.prisma.streamGuest.count({ where: { streamId, status: StreamGuestStatus.ACTIVE } });
  }

  async isOnRemovalCooldown(streamId: string, userId: string): Promise<boolean> {
    const exists = await this.redis.getClient().exists(this.cooldownKey(streamId, userId));
    return exists === 1;
  }

  /** Viewer raises their hand (plan §6.5). StreamsService has already confirmed the stream is live and this viewer isn't banned. */
  async request(streamId: string, hostId: string, userId: string): Promise<{ id: string }> {
    if (userId === hostId)
      throw new BadRequestException("You can't request to join your own stream");
    if (await this.isActiveGuest(streamId, userId))
      throw new BadRequestException("You're already a guest");
    if (await this.isOnRemovalCooldown(streamId, userId)) {
      throw new ForbiddenException('You were recently removed from this stream - try again later');
    }
    await this.assertNoPending(streamId, userId);

    const row = await this.prisma.guestRequest.create({
      data: { streamId, userId, initiatedBy: GuestRequestInitiator.VIEWER },
      select: { id: true, user: { select: PROFILE_SUMMARY_SELECT } },
    });

    const recipientIds = await this.eligibleRecipients(streamId, hostId);
    this.events.emit(DomainEvents.GuestRequestCreated, {
      streamId,
      requestId: row.id,
      initiatedBy: GuestRequestInitiator.VIEWER,
      user: row.user,
      recipientIds,
    } satisfies GuestRequestCreatedPayload);
    return { id: row.id };
  }

  /** Host invites someone on stage - the reverse direction (plan §6.5), host-only (StreamsService checks that). */
  async invite(streamId: string, hostId: string, userId: string): Promise<{ id: string }> {
    if (userId === hostId) throw new BadRequestException("You can't invite yourself");
    if (await this.isActiveGuest(streamId, userId))
      throw new BadRequestException('Already a guest');
    await this.assertNoPending(streamId, userId);

    const row = await this.prisma.guestRequest.create({
      data: { streamId, userId, initiatedBy: GuestRequestInitiator.HOST },
      select: { id: true, user: { select: PROFILE_SUMMARY_SELECT } },
    });
    this.events.emit(DomainEvents.GuestRequestCreated, {
      streamId,
      requestId: row.id,
      initiatedBy: GuestRequestInitiator.HOST,
      user: row.user,
      recipientIds: [userId],
    } satisfies GuestRequestCreatedPayload);
    return { id: row.id };
  }

  /** VIEWER-initiated pending requests only, oldest first - the host/mod incoming-requests sheet (plan §6.5). */
  async listPending(streamId: string) {
    const rows = await this.prisma.guestRequest.findMany({
      where: {
        streamId,
        status: GuestRequestStatus.PENDING,
        initiatedBy: GuestRequestInitiator.VIEWER,
      },
      orderBy: { requestedAt: 'asc' },
      select: { id: true, requestedAt: true, user: { select: PROFILE_SUMMARY_SELECT } },
    });
    return { items: rows };
  }

  async findPendingOrThrow(streamId: string, requestId: string) {
    const row = await this.prisma.guestRequest.findUnique({ where: { id: requestId } });
    if (!row || row.streamId !== streamId) throw new NotFoundException('Request not found');
    if (row.status !== GuestRequestStatus.PENDING)
      throw new BadRequestException('This request was already resolved');
    return row;
  }

  /** This user's own open request or invite for this stream, if any - either direction (plan §6.5). */
  async findOwnPending(streamId: string, userId: string) {
    return this.prisma.guestRequest.findFirst({
      where: { streamId, userId, status: GuestRequestStatus.PENDING },
      orderBy: { requestedAt: 'desc' },
      select: { id: true, initiatedBy: true, requestedAt: true },
    });
  }

  /** Called by StreamsService once it's minted `credentials` and confirmed the guest cap. */
  async accept(streamId: string, requestId: string, credentials: VideoCredentials): Promise<void> {
    const request = await this.findPendingOrThrow(streamId, requestId);
    const now = new Date();
    await this.prisma.guestRequest.update({
      where: { id: requestId },
      data: { status: GuestRequestStatus.ACCEPTED, resolvedAt: now },
    });
    const [, user] = await Promise.all([
      this.prisma.streamGuest.upsert({
        where: { streamId_userId: { streamId, userId: request.userId } },
        create: { streamId, userId: request.userId },
        // A new seat starts with the mic allowed, whatever happened last time.
        update: {
          status: StreamGuestStatus.ACTIVE,
          joinedAt: now,
          leftAt: null,
          micForceMuted: false,
        },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: request.userId },
        select: PROFILE_SUMMARY_SELECT,
      }),
    ]);

    this.events.emit(DomainEvents.GuestRequestAccepted, {
      streamId,
      requestId,
      userId: request.userId,
      credentials,
    } satisfies GuestRequestAcceptedPayload);
    this.events.emit(DomainEvents.GuestJoined, {
      streamId,
      user,
      agoraUid: credentials.provider === VideoProviderKind.AGORA ? credentials.uid : null,
    } satisfies GuestJoinedPayload);
  }

  async reject(streamId: string, requestId: string): Promise<void> {
    const request = await this.findPendingOrThrow(streamId, requestId);
    await this.prisma.guestRequest.update({
      where: { id: requestId },
      data: { status: GuestRequestStatus.REJECTED, resolvedAt: new Date() },
    });
    this.events.emit(DomainEvents.GuestRequestRejected, {
      streamId,
      requestId,
      userId: request.userId,
    } satisfies GuestRequestRejectedPayload);
  }

  /** The originator backs out - the VIEWER withdrawing their own request, or the HOST retracting their own invite. */
  async cancel(
    streamId: string,
    requestId: string,
    actorId: string,
    hostId: string,
  ): Promise<void> {
    const request = await this.findPendingOrThrow(streamId, requestId);
    const isOwnRequest =
      request.initiatedBy === GuestRequestInitiator.VIEWER && request.userId === actorId;
    const isOwnInvite = request.initiatedBy === GuestRequestInitiator.HOST && actorId === hostId;
    if (!isOwnRequest && !isOwnInvite) throw new ForbiddenException("You can't cancel this");

    await this.prisma.guestRequest.update({
      where: { id: requestId },
      data: { status: GuestRequestStatus.CANCELLED, resolvedAt: new Date() },
    });
    const recipientIds =
      request.initiatedBy === GuestRequestInitiator.VIEWER
        ? await this.eligibleRecipients(streamId, hostId)
        : [request.userId];
    this.events.emit(DomainEvents.GuestRequestCancelled, {
      streamId,
      requestId,
      initiatedBy: request.initiatedBy,
      recipientIds,
    } satisfies GuestRequestCancelledPayload);
  }

  /** Every active guest, oldest seat first - the tile order (plan §6.6), and what a viewer joining mid-stream needs to render them. */
  async activeGuests(streamId: string) {
    const rows = await this.prisma.streamGuest.findMany({
      where: { streamId, status: StreamGuestStatus.ACTIVE },
      orderBy: { joinedAt: 'asc' },
      select: { joinedAt: true, micForceMuted: true, user: { select: PROFILE_SUMMARY_SELECT } },
    });
    // agoraUid is meaningless (but harmless) for a LiveKit stream, where a
    // client instead correlates by identity=userId directly - included
    // unconditionally since it's a pure deterministic function, cheaper than
    // threading the stream's videoProvider kind through this call.
    return rows.map((row) => ({
      ...row.user,
      joinedAt: row.joinedAt,
      agoraUid: agoraUidFor(row.user.id),
      micForceMuted: row.micForceMuted,
    }));
  }

  /**
   * Host/moderator mic mute (plan §6.7): the guest's app turns the mic off
   * and keeps it off until lifted. Lifting only lets them unmute again - it
   * never turns anyone's mic on. Idempotent, like remove().
   */
  async setMicForceMuted(
    streamId: string,
    userId: string,
    actorId: string,
    forceMuted: boolean,
  ): Promise<void> {
    const { count } = await this.prisma.streamGuest.updateMany({
      where: { streamId, userId, status: StreamGuestStatus.ACTIVE, micForceMuted: !forceMuted },
      data: { micForceMuted: forceMuted },
    });
    if (count === 0) {
      // Already that way is fine; not being on stage isn't.
      if (!(await this.isActiveGuest(streamId, userId)))
        throw new NotFoundException("They're not on stage");
      return;
    }
    this.events.emit(DomainEvents.GuestMicForceMuteChanged, {
      streamId,
      userId,
      actorId,
      forceMuted,
    } satisfies GuestMicForceMuteChangedPayload);
  }

  /**
   * Flips an active guest to removed - idempotent (already-removed is a
   * harmless no-op, matching follow/block elsewhere in this app). Sets the
   * cooldown and marks `wasRemovedByHostOrModerator` only for a host/moderator
   * -initiated removal, never for the guest's own "leave seat" (plan §6.6).
   */
  async remove(
    streamId: string,
    hostId: string,
    userId: string,
    removedByHostOrModerator: boolean,
    actorId?: string,
  ): Promise<void> {
    const result = await this.prisma.streamGuest.updateMany({
      where: { streamId, userId, status: StreamGuestStatus.ACTIVE },
      data: { status: StreamGuestStatus.REMOVED, leftAt: new Date() },
    });
    if (result.count === 0) return;

    if (removedByHostOrModerator) {
      await this.redis
        .getClient()
        .set(this.cooldownKey(streamId, userId), '1', 'EX', REMOVAL_COOLDOWN_SECONDS);
    }
    this.events.emit(DomainEvents.GuestRemoved, {
      streamId,
      hostId,
      userId,
      wasRemovedByHostOrModerator: removedByHostOrModerator,
      actorId: actorId ?? (removedByHostOrModerator ? hostId : userId),
    } satisfies GuestRemovedPayload);
  }

  /** Ending the stream cascades: every active guest becomes removed - pure data cleanup, `stream_ended` already tears every client down (plan §6.6). */
  async removeAllForEndedStream(streamId: string): Promise<void> {
    await this.prisma.streamGuest.updateMany({
      where: { streamId, status: StreamGuestStatus.ACTIVE },
      data: { status: StreamGuestStatus.REMOVED, leftAt: new Date() },
    });
  }

  private async assertNoPending(streamId: string, userId: string): Promise<void> {
    const existing = await this.prisma.guestRequest.findFirst({
      where: { streamId, userId, status: GuestRequestStatus.PENDING },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('Already a pending request for this stream');
  }

  private async eligibleRecipients(streamId: string, hostId: string): Promise<string[]> {
    const moderatorIds = await this.moderators.listUserIdsWithCapability(
      streamId,
      ModeratorCapability.MANAGE_GUEST_REQUESTS,
    );
    return [hostId, ...moderatorIds];
  }

  private cooldownKey(streamId: string, userId: string): string {
    return `guest_cooldown:${streamId}:${userId}`;
  }
}
