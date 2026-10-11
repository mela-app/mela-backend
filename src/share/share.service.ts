import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StreamStatus, StreamVisibility, UserStatus } from '@prisma/client';
import { DomainEvents, StreamInviteSentPayload } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimit, RateLimitService } from '../common/rate-limit/rate-limit.service';
import { RedisService } from '../common/redis/redis.service';
import { SocialService } from '../social/social.service';
import { canWatchLive } from '../streams/live-audience';

const INVITE_CAP_PER_STREAM = 20;
const INVITE_RATE_LIMIT: RateLimit = { capacity: 5, refillMs: 60_000 };
// Just bounds the per-stream invite-cap set's lifetime in Redis - a stream
// this old has long since ended one way or another.
const INVITE_SET_TTL_SECONDS = 24 * 60 * 60;

/**
 * "Send to friends" from the live screen (plan §6.12) - never a spam vector.
 * Anyone may be sent it, friend or not (client request, 2026-10), but each
 * person only once per live from the same sender, at most
 * {@link INVITE_CAP_PER_STREAM} of them. See docs/features/share.md.
 */
@Injectable()
export class ShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly social: SocialService,
    private readonly rateLimit: RateLimitService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
  ) {}

  async sendInvites(
    streamId: string,
    senderId: string,
    userIds: string[],
  ): Promise<{ invited: string[] }> {
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
    if (recipients.length === 0) return { invited: [] };

    const capKey = `invite:${streamId}:${senderId}`;
    const client = this.redis.getClient();
    const alreadyInvited = new Set(await client.smembers(capKey));
    const room = INVITE_CAP_PER_STREAM - alreadyInvited.size;
    if (room <= 0) {
      throw new ForbiddenException(
        `You've already invited the max of ${INVITE_CAP_PER_STREAM} people to this live`,
      );
    }

    // Once per person per live: someone already sent it isn't sent it again.
    const toInvite = recipients.filter((id) => !alreadyInvited.has(id)).slice(0, room);
    if (toInvite.length === 0) return { invited: [] };

    await client.sadd(capKey, ...toInvite);
    await client.expire(capKey, INVITE_SET_TTL_SECONDS);

    this.events.emit(DomainEvents.StreamInviteSent, {
      streamId,
      senderId,
      recipientIds: toInvite,
    } satisfies StreamInviteSentPayload);

    return { invited: toInvite };
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
