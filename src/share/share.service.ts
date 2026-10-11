import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StreamStatus, StreamVisibility } from '@prisma/client';
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

/** "Send to friends" from the live screen (plan §6.12) - never a spam vector. See docs/features/share.md. */
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

    // Friends only - re-checked here even though the mobile "send to
    // friends" sheet only ever lists friends, since the server never trusts
    // a client-supplied id list at face value.
    const candidates = [...new Set(userIds)].filter((id) => id !== senderId);
    const isFriend = await Promise.all(candidates.map((id) => this.social.isFriend(senderId, id)));
    const befriended = candidates.filter((_, index) => isFriend[index]);
    // And only those who may watch it: a followers' or friends' live is the host's to open up.
    const canWatch = await Promise.all(
      befriended.map((id) => this.canWatch(stream.hostId, stream.visibility, id)),
    );
    const friends = befriended.filter((_, index) => canWatch[index]);
    if (friends.length === 0) return { invited: [] };

    const capKey = `invite:${streamId}:${senderId}`;
    const client = this.redis.getClient();
    const alreadyInvited = new Set(await client.smembers(capKey));
    const room = INVITE_CAP_PER_STREAM - alreadyInvited.size;
    if (room <= 0) {
      throw new ForbiddenException(
        `You've already invited the max of ${INVITE_CAP_PER_STREAM} people to this live`,
      );
    }

    const toInvite = friends.filter((id) => !alreadyInvited.has(id)).slice(0, room);
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
