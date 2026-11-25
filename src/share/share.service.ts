import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StreamStatus, StreamVisibility, UserStatus } from '@prisma/client';
import { DomainEvents, StreamInviteSentPayload } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimit, RateLimitService } from '../common/rate-limit/rate-limit.service';
import { RedisService } from '../common/redis/redis.service';
import { DirectMessagesService } from '../direct-messages/direct-messages.service';
import { SocialService } from '../social/social.service';
import { canWatchLive } from '../streams/live-audience';

const INVITE_CAP_PER_STREAM = 20;

export interface SendInvitesResult {
  // Who was sent it now.
  invited: string[];
  // Of those asked, the ones who don't follow each other with the sender and
  // have had this live from them now: not again (the app shows them as sent).
  sentOnce: string[];
}
const INVITE_RATE_LIMIT: RateLimit = { capacity: 5, refillMs: 60_000 };
// Just bounds the per-stream invite-cap set's lifetime in Redis - a stream
// this old has long since ended one way or another.
const INVITE_SET_TTL_SECONDS = 24 * 60 * 60;

/**
 * "Send to friends" from the live screen (plan §6.12) - never a spam vector.
 * Anyone may be sent it (client request, 2026-10). Two people who follow each
 * other may send each other a live as often as they like; anyone else gets it
 * once per live from the same sender, at most {@link INVITE_CAP_PER_STREAM}
 * such people (client request, 2026-11). Each one sent lands in the
 * recipient's private chat too, as a card to join from. See docs/features/share.md.
 */
@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly social: SocialService,
    private readonly rateLimit: RateLimitService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
    private readonly directMessages: DirectMessagesService,
  ) {}

  async sendInvites(
    streamId: string,
    senderId: string,
    userIds: string[],
  ): Promise<SendInvitesResult> {
    const stream = await this.prisma.stream.findUnique({
      where: { id: streamId },
      select: { status: true, hostId: true, visibility: true },
    });
    if (!stream || stream.status !== StreamStatus.LIVE)
      throw new NotFoundException('This live has ended');

    const waitMs = await this.rateLimit.take(`invite:${senderId}`, INVITE_RATE_LIMIT);
    if (waitMs > 0) throw new BadRequestException('Slow down - try again in a moment');

    // Never trust a client-supplied id list: only active accounts nobody
    // involved has blocked - neither the sender nor the host.
    const ids = [...new Set(userIds)].filter((id) => id !== senderId);
    const [active, blocked] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids }, status: UserStatus.ACTIVE },
        select: { id: true },
      }),
      this.blockedBy(senderId, stream.hostId),
    ]);
    const activeIds = new Set(active.map((user) => user.id));
    const candidates = ids.filter((id) => activeIds.has(id) && !blocked.has(id));
    // And only those who may watch it: a followers' or friends' live is the host's to open up.
    const canWatch = await Promise.all(
      candidates.map((id) => this.canWatch(stream.hostId, stream.visibility, id)),
    );
    const recipients = candidates.filter((_, index) => canWatch[index]);
    if (recipients.length === 0) return { invited: [], sentOnce: [] };

    // Following each other: as often as they like (the sender's pace still applies).
    const isFriend = await Promise.all(recipients.map((id) => this.social.isFriend(senderId, id)));
    const friends = recipients.filter((_, index) => isFriend[index]);
    const others = recipients.filter((_, index) => !isFriend[index]);
    const once = await this.firstTimeOthers(streamId, senderId, others, friends.length);
    const toInvite = [...friends, ...once.invited];
    if (toInvite.length === 0) return { invited: [], sentOnce: once.sentOnce };

    this.events.emit(DomainEvents.StreamInviteSent, {
      streamId,
      senderId,
      recipientIds: toInvite,
    } satisfies StreamInviteSentPayload);

    // In each one's private chat too - a failure there still leaves the notification.
    await Promise.all(
      toInvite.map((recipientId) =>
        this.directMessages.shareLive(senderId, recipientId, streamId).catch((error: unknown) => {
          this.logger.warn(
            `Could not put the shared live in ${recipientId}'s chat: ${String(error)}`,
          );
        }),
      ),
    );

    return { invited: toInvite, sentOnce: once.sentOnce };
  }

  /**
   * Of [others] (not following each other with the sender), those not sent
   * this live by them yet, within the cap - now marked as sent - and which of
   * them all have had it now. Over the cap with nobody else to send to, it says so.
   */
  private async firstTimeOthers(
    streamId: string,
    senderId: string,
    others: string[],
    friendCount: number,
  ): Promise<{ invited: string[]; sentOnce: string[] }> {
    if (others.length === 0) return { invited: [], sentOnce: [] };
    const capKey = `invite:${streamId}:${senderId}`;
    const client = this.redis.getClient();
    const alreadyInvited = new Set(await client.smembers(capKey));
    const fresh = others.filter((id) => !alreadyInvited.has(id));
    const room = INVITE_CAP_PER_STREAM - alreadyInvited.size;
    if (fresh.length > 0 && room <= 0 && friendCount === 0) {
      throw new ForbiddenException(
        `You've already sent this live to ${INVITE_CAP_PER_STREAM} people who don't follow you back`,
      );
    }
    const toInvite = fresh.slice(0, Math.max(0, room));
    if (toInvite.length > 0) {
      await client.sadd(capKey, ...toInvite);
      await client.expire(capKey, INVITE_SET_TTL_SECONDS);
    }
    const sent = new Set([...alreadyInvited, ...toInvite]);
    return { invited: toInvite, sentOnce: others.filter((id) => sent.has(id)) };
  }

  /** Everyone who blocked, or was blocked by, any of these people. */
  private async blockedBy(...userIds: string[]): Promise<Set<string>> {
    const lists = await Promise.all(
      [...new Set(userIds)].map((id) => this.social.blockedEitherWayUserIds(id)),
    );
    return new Set(lists.flat());
  }

  private async canWatch(
    hostId: string,
    visibility: StreamVisibility,
    userId: string,
  ): Promise<boolean> {
    if (visibility === StreamVisibility.PUBLIC) return true;
    const [follows, followedBack] = await Promise.all([
      this.social.isFollowing(userId, hostId),
      this.social.isFollowing(hostId, userId),
    ]);
    return canWatchLive(visibility, {
      isHost: userId === hostId,
      follows,
      isFriend: follows && followedBack,
    });
  }
}
