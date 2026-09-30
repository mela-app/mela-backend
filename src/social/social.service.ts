import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserStatus } from '@prisma/client';
import { DomainEvents, UserBlockedPayload, UserUnfollowedPayload } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { canViewProfileDetails, ProfileViewer } from './profile-visibility';

const PROFILE_SUMMARY_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** The follow graph: follow/unfollow, lists, search. See docs/features/social.md. */
@Injectable()
export class SocialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /** Idempotent - following someone you already follow just succeeds again. */
  async follow(followerId: string, followeeId: string): Promise<{ ok: true }> {
    if (followerId === followeeId) throw new BadRequestException("You can't follow yourself");
    const followee = await this.prisma.user.findUnique({ where: { id: followeeId }, select: { id: true } });
    if (!followee) throw new NotFoundException('User not found');
    if (await this.isBlockedEitherWay(followerId, followeeId)) {
      throw new ForbiddenException("You can't follow this user");
    }

    await this.prisma.follow.upsert({
      where: { followerId_followeeId: { followerId, followeeId } },
      create: { followerId, followeeId },
      update: {},
    });
    this.events.emit(DomainEvents.UserFollowed, { followerId, followeeId });
    return { ok: true };
  }

  /** Idempotent - unfollowing someone you don't follow is a no-op, not an error. */
  async unfollow(followerId: string, followeeId: string): Promise<{ ok: true }> {
    const { count } = await this.prisma.follow.deleteMany({ where: { followerId, followeeId } });
    if (count > 0) {
      this.events.emit(DomainEvents.UserUnfollowed, { followerId, followeeId } satisfies UserUnfollowedPayload);
    }
    return { ok: true };
  }

  /**
   * Personal block (plan §6.4): hides the blocked user's messages/streams for
   * the blocker (enforced client-side) and deletes any follow between them
   * both ways. Idempotent, like follow.
   */
  async block(blockerId: string, blockedId: string): Promise<{ ok: true }> {
    if (blockerId === blockedId) throw new BadRequestException("You can't block yourself");
    const target = await this.prisma.user.findUnique({ where: { id: blockedId }, select: { id: true } });
    if (!target) throw new NotFoundException('User not found');

    await this.prisma.$transaction([
      this.prisma.block.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId } },
        create: { blockerId, blockedId },
        update: {},
      }),
      this.prisma.follow.deleteMany({
        where: {
          OR: [
            { followerId: blockerId, followeeId: blockedId },
            { followerId: blockedId, followeeId: blockerId },
          ],
        },
      }),
    ]);
    this.events.emit(DomainEvents.UserBlocked, { blockerId, blockedId } satisfies UserBlockedPayload);
    return { ok: true };
  }

  /** Idempotent - unblocking someone you haven't blocked is a no-op. */
  async unblock(blockerId: string, blockedId: string): Promise<{ ok: true }> {
    const { count } = await this.prisma.block.deleteMany({ where: { blockerId, blockedId } });
    if (count > 0) {
      this.events.emit(DomainEvents.UserUnblocked, { blockerId, blockedId } satisfies UserBlockedPayload);
    }
    return { ok: true };
  }

  /**
   * Personal chat mute (plan §6.7): the muter's apps stop showing this
   * person's chat messages. Lighter than a block - following and watching
   * are unaffected, and the muted person isn't told. Idempotent, like block.
   */
  async muteInChat(userId: string, mutedUserId: string): Promise<{ ok: true }> {
    if (userId === mutedUserId) throw new BadRequestException("You can't mute yourself");
    const target = await this.prisma.user.findUnique({ where: { id: mutedUserId }, select: { id: true } });
    if (!target) throw new NotFoundException('User not found');

    await this.prisma.personalChatMute.upsert({
      where: { userId_mutedUserId: { userId, mutedUserId } },
      create: { userId, mutedUserId },
      update: {},
    });
    return { ok: true };
  }

  /** Idempotent - unmuting someone you haven't muted is a no-op. */
  async unmuteInChat(userId: string, mutedUserId: string): Promise<{ ok: true }> {
    await this.prisma.personalChatMute.deleteMany({ where: { userId, mutedUserId } });
    return { ok: true };
  }

  /**
   * Whose chat messages this user's app hides (plan §6.4, §6.7): people they
   * muted in chat, and people they blocked - only their own choices, since
   * who blocked them isn't theirs to know.
   */
  async chatFilter(userId: string): Promise<{ mutedUserIds: string[]; blockedUserIds: string[] }> {
    const [mutes, blocks] = await Promise.all([
      this.prisma.personalChatMute.findMany({ where: { userId }, select: { mutedUserId: true } }),
      this.prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } }),
    ]);
    return {
      mutedUserIds: mutes.map((row) => row.mutedUserId),
      blockedUserIds: blocks.map((row) => row.blockedId),
    };
  }

  /** True if either side has blocked the other - gates following, and hides them from search/discovery. */
  async isBlockedEitherWay(userId: string, otherUserId: string): Promise<boolean> {
    if (userId === otherUserId) return false;
    const block = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: userId, blockedId: otherUserId },
          { blockerId: otherUserId, blockedId: userId },
        ],
      },
      select: { id: true },
    });
    return block !== null;
  }

  /** Every user id blocking, or blocked by, this user - for excluding their streams/results elsewhere. */
  async blockedEitherWayUserIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    const ids = new Set<string>();
    for (const row of rows) ids.add(row.blockerId === userId ? row.blockedId : row.blockerId);
    return [...ids];
  }

  /** A single indexed lookup - cheaper than {@link getRelationshipSummary} when only this is needed (e.g. joining a live). */
  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    if (followerId === followeeId) return false;
    const follow = await this.prisma.follow.findUnique({
      where: { followerId_followeeId: { followerId, followeeId } },
      select: { followerId: true },
    });
    return follow !== null;
  }

  /** Mutual follows both ways - gates who can be sent a live invite (plan §6.12). */
  async isFriend(userId: string, otherUserId: string): Promise<boolean> {
    if (userId === otherUserId) return false;
    const [a, b] = await Promise.all([this.isFollowing(userId, otherUserId), this.isFollowing(otherUserId, userId)]);
    return a && b;
  }

  /** The bell on a profile (plan §6.10) - only meaningful while already following. */
  async setNotifyOnLive(followerId: string, followeeId: string, notifyOnLive: boolean): Promise<{ ok: true }> {
    const result = await this.prisma.follow.updateMany({
      where: { followerId, followeeId },
      data: { notifyOnLive },
    });
    if (result.count === 0) throw new NotFoundException('Not following this user');
    return { ok: true };
  }

  /** Counts + this viewer's relationship to `profileId` - one query either way. */
  async getRelationshipSummary(profileId: string, requesterId?: string) {
    const hasRequester = Boolean(requesterId && requesterId !== profileId);
    const [followerCount, followingCount, relation, isBlocked, isMutedInChat] = await Promise.all([
      this.prisma.follow.count({ where: { followeeId: profileId } }),
      this.prisma.follow.count({ where: { followerId: profileId } }),
      hasRequester
        ? this.prisma.follow.findMany({
            where: {
              OR: [
                { followerId: requesterId, followeeId: profileId },
                { followerId: profileId, followeeId: requesterId },
              ],
            },
            select: { followerId: true, notifyOnLive: true },
          })
        : Promise.resolve([]),
      hasRequester ? this.isBlockedByViewer(requesterId!, profileId) : Promise.resolve(false),
      hasRequester ? this.isMutedInChatByViewer(requesterId!, profileId) : Promise.resolve(false),
    ]);
    const isFollowing = relation.some((row) => row.followerId === requesterId);
    const isFollowedBy = relation.some((row) => row.followerId === profileId);
    // Only meaningful while isFollowing - the bell toggle on a profile (plan §6.10).
    const notifyOnLive = relation.find((row) => row.followerId === requesterId)?.notifyOnLive ?? false;
    return {
      followerCount,
      followingCount,
      isFollowing,
      isFollowedBy,
      isFriend: isFollowing && isFollowedBy,
      notifyOnLive,
      // One-directional on purpose (plan §6.4): whether the *other side* has
      // also blocked you isn't surfaced - following/joining are already
      // blocked either way regardless, without telling you which side did it.
      isBlocked,
      // The profile's "Mute in chats" toggle (plan §6.7).
      isMutedInChat,
    };
  }

  /** Whether `viewerId` specifically has blocked `targetId` - directional, unlike {@link isBlockedEitherWay}. */
  async isBlockedByViewer(viewerId: string, targetId: string): Promise<boolean> {
    const block = await this.prisma.block.findUnique({
      where: { blockerId_blockedId: { blockerId: viewerId, blockedId: targetId } },
      select: { id: true },
    });
    return block !== null;
  }

  private async isMutedInChatByViewer(viewerId: string, targetId: string): Promise<boolean> {
    const mute = await this.prisma.personalChatMute.findUnique({
      where: { userId_mutedUserId: { userId: viewerId, mutedUserId: targetId } },
      select: { id: true },
    });
    return mute !== null;
  }

  /** How [requesterId] relates to [profileId], for the owner's profile visibility. */
  async profileViewer(profileId: string, requesterId?: string): Promise<ProfileViewer> {
    const stranger = { isSelf: false, isFollower: false, isFriend: false, blockedByOwner: false };
    if (!requesterId) return stranger;
    if (requesterId === profileId) return { ...stranger, isSelf: true };
    const [isFollower, isFollowedBy, blockedByOwner] = await Promise.all([
      this.isFollowing(requesterId, profileId),
      this.isFollowing(profileId, requesterId),
      this.isBlockedByViewer(profileId, requesterId),
    ]);
    return { isSelf: false, isFollower, isFriend: isFollower && isFollowedBy, blockedByOwner };
  }

  // Who someone follows, and who follows them, are profile details too.
  private async assertCanViewDetails(profileId: string, requesterId?: string): Promise<void> {
    const owner = await this.prisma.user.findUnique({ where: { id: profileId }, select: { profileVisibility: true } });
    if (!owner) throw new NotFoundException('User not found');
    if (canViewProfileDetails(owner.profileVisibility, await this.profileViewer(profileId, requesterId))) return;
    throw new ForbiddenException({ message: 'This profile is private', code: 'PROFILE_PRIVATE' });
  }

  async listFollowers(userId: string, requesterId?: string, cursor?: string, limit = 30) {
    await this.assertCanViewDetails(userId, requesterId);
    const rows = await this.prisma.follow.findMany({
      where: { followeeId: userId, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true, follower: { select: PROFILE_SUMMARY_SELECT } },
    });
    return this.toPage(
      rows.map((row) => ({ cursorId: row.id, value: row.follower })),
      limit,
    );
  }

  async listFollowing(userId: string, requesterId?: string, cursor?: string, limit = 30) {
    await this.assertCanViewDetails(userId, requesterId);
    const rows = await this.prisma.follow.findMany({
      where: { followerId: userId, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true, followee: { select: PROFILE_SUMMARY_SELECT } },
    });
    return this.toPage(
      rows.map((row) => ({ cursorId: row.id, value: row.followee })),
      limit,
    );
  }

  /** Mutual follows - shown as Friends, without their own table (plan §6.10). */
  async listFriends(userId: string, cursor?: string, limit = 30) {
    const rows = await this.prisma.follow.findMany({
      where: {
        followerId: userId,
        followee: { following: { some: { followeeId: userId } } },
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true, followee: { select: PROFILE_SUMMARY_SELECT } },
    });
    return this.toPage(
      rows.map((row) => ({ cursorId: row.id, value: row.followee })),
      limit,
    );
  }

  /** Prefix match on username/display name (plan §6.10) - excludes suspended accounts, anyone blocked either way, and, optionally, yourself. */
  async search(query: string, requesterId: string | undefined, cursor?: string, limit = 20) {
    const q = query.trim();
    if (!q) return { items: [], hasMore: false, nextCursor: null };

    // Both exclusions key on `id`, so they must merge into one `notIn` list -
    // two separate `id` filters spread into the same object would just have
    // the second silently overwrite the first.
    const excludedIds = requesterId ? [requesterId, ...(await this.blockedEitherWayUserIds(requesterId))] : [];
    const rows = await this.prisma.user.findMany({
      where: {
        status: UserStatus.ACTIVE,
        ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
        ...(cursor ? { username: { gt: cursor } } : {}),
        OR: [
          { username: { startsWith: q, mode: 'insensitive' } },
          { displayName: { startsWith: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { username: 'asc' },
      take: limit + 1,
      select: PROFILE_SUMMARY_SELECT,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items, hasMore, nextCursor: hasMore ? items[items.length - 1].username : null };
  }

  private toPage<T>(rows: Array<{ cursorId: string; value: T }>, limit: number): Page<T> {
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => row.value),
      hasMore,
      nextCursor: hasMore ? page[page.length - 1].cursorId : null,
    };
  }
}
