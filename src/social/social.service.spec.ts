import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProfileVisibility, UserStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { SocialService } from './social.service';

describe('SocialService', () => {
  const prisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    follow: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    block: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    personalChatMute: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
  const events = { emit: jest.fn() };

  const service = () => new SocialService(prisma as unknown as PrismaService, events as never);

  beforeEach(() => jest.clearAllMocks());

  describe('follow', () => {
    it('refuses to let a user follow themselves', async () => {
      await expect(service().follow('u1', 'u1')).rejects.toThrow(BadRequestException);
      expect(prisma.follow.upsert).not.toHaveBeenCalled();
    });

    it("404s when the followee doesn't exist", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service().follow('u1', 'ghost')).rejects.toThrow(NotFoundException);
    });

    it('upserts (idempotent) and emits user.followed', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });

      await expect(service().follow('u1', 'u2')).resolves.toEqual({ ok: true });

      expect(prisma.follow.upsert).toHaveBeenCalledWith({
        where: { followerId_followeeId: { followerId: 'u1', followeeId: 'u2' } },
        create: { followerId: 'u1', followeeId: 'u2' },
        update: {},
      });
      expect(events.emit).toHaveBeenCalledWith('user.followed', {
        followerId: 'u1',
        followeeId: 'u2',
      });
    });

    it('refuses to follow someone blocked either way', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      prisma.block.findFirst.mockResolvedValueOnce({ id: 'b1' });

      await expect(service().follow('u1', 'u2')).rejects.toThrow(ForbiddenException);
      expect(prisma.follow.upsert).not.toHaveBeenCalled();
    });
  });

  describe('block', () => {
    it('refuses to let a user block themselves', async () => {
      await expect(service().block('u1', 'u1')).rejects.toThrow(BadRequestException);
      expect(prisma.block.upsert).not.toHaveBeenCalled();
    });

    it('404s when the target does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service().block('u1', 'ghost')).rejects.toThrow(NotFoundException);
    });

    it('upserts (idempotent) and removes any follow between them, both ways', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });

      await expect(service().block('u1', 'u2')).resolves.toEqual({ ok: true });

      expect(prisma.block.upsert).toHaveBeenCalledWith({
        where: { blockerId_blockedId: { blockerId: 'u1', blockedId: 'u2' } },
        create: { blockerId: 'u1', blockedId: 'u2' },
        update: {},
      });
      expect(prisma.follow.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { followerId: 'u1', followeeId: 'u2' },
            { followerId: 'u2', followeeId: 'u1' },
          ],
        },
      });
    });
  });

  describe('unblock', () => {
    it('succeeds even when there was nothing to unblock', async () => {
      prisma.block.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service().unblock('u1', 'u2')).resolves.toEqual({ ok: true });
    });
  });

  describe('muteInChat', () => {
    it('refuses to mute yourself', async () => {
      await expect(service().muteInChat('u1', 'u1')).rejects.toThrow(BadRequestException);
      expect(prisma.personalChatMute.upsert).not.toHaveBeenCalled();
    });

    it('404s for a user that does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service().muteInChat('u1', 'ghost')).rejects.toThrow(NotFoundException);
    });

    it('upserts, so muting twice just succeeds again', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });

      await expect(service().muteInChat('u1', 'u2')).resolves.toEqual({ ok: true });

      expect(prisma.personalChatMute.upsert).toHaveBeenCalledWith({
        where: { userId_mutedUserId: { userId: 'u1', mutedUserId: 'u2' } },
        create: { userId: 'u1', mutedUserId: 'u2' },
        update: {},
      });
      // Lighter than a block: follows stay.
      expect(prisma.follow.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('unmuteInChat', () => {
    it('succeeds even when there was nothing to unmute', async () => {
      prisma.personalChatMute.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service().unmuteInChat('u1', 'u2')).resolves.toEqual({ ok: true });
      expect(prisma.personalChatMute.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', mutedUserId: 'u2' },
      });
    });
  });

  describe('chatFilter', () => {
    it('lists who this user muted in chat and who they blocked - not who blocked them', async () => {
      prisma.personalChatMute.findMany.mockResolvedValue([{ mutedUserId: 'm1' }]);
      prisma.block.findMany.mockResolvedValue([{ blockedId: 'b1' }]);

      await expect(service().chatFilter('u1')).resolves.toEqual({
        mutedUserIds: ['m1'],
        blockedUserIds: ['b1'],
      });

      expect(prisma.personalChatMute.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        select: { mutedUserId: true },
      });
      expect(prisma.block.findMany).toHaveBeenCalledWith({
        where: { blockerId: 'u1' },
        select: { blockedId: true },
      });
    });
  });

  describe('isBlockedEitherWay', () => {
    it('is always false for yourself', async () => {
      await expect(service().isBlockedEitherWay('u1', 'u1')).resolves.toBe(false);
      expect(prisma.block.findFirst).not.toHaveBeenCalled();
    });

    it('is true whichever side did the blocking', async () => {
      prisma.block.findFirst.mockResolvedValueOnce({ id: 'b1' });
      await expect(service().isBlockedEitherWay('u1', 'u2')).resolves.toBe(true);
      expect(prisma.block.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { blockerId: 'u1', blockedId: 'u2' },
              { blockerId: 'u2', blockedId: 'u1' },
            ],
          },
        }),
      );
    });
  });

  describe('blockedEitherWayUserIds', () => {
    it('dedupes and returns the other side of every block row', async () => {
      prisma.block.findMany.mockResolvedValueOnce([
        { blockerId: 'me', blockedId: 'a' },
        { blockerId: 'b', blockedId: 'me' },
      ]);

      const ids = await service().blockedEitherWayUserIds('me');

      expect(ids.sort()).toEqual(['a', 'b']);
    });
  });

  describe('unfollow', () => {
    it('succeeds even when there was nothing to unfollow', async () => {
      prisma.follow.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service().unfollow('u1', 'u2')).resolves.toEqual({ ok: true });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('announces an unfollow that happened, for the audit trail', async () => {
      prisma.follow.deleteMany.mockResolvedValue({ count: 1 });
      await service().unfollow('u1', 'u2');
      expect(events.emit).toHaveBeenCalledWith('user.unfollowed', {
        followerId: 'u1',
        followeeId: 'u2',
      });
    });
  });

  describe('isFriend', () => {
    it('is always false for yourself', async () => {
      await expect(service().isFriend('u1', 'u1')).resolves.toBe(false);
      expect(prisma.follow.findUnique).not.toHaveBeenCalled();
    });

    it('is false when only one side follows', async () => {
      prisma.follow.findUnique
        .mockResolvedValueOnce({ followerId: 'u1' })
        .mockResolvedValueOnce(null);
      await expect(service().isFriend('u1', 'u2')).resolves.toBe(false);
    });

    it('is true when both sides follow each other', async () => {
      prisma.follow.findUnique.mockResolvedValue({ followerId: 'x' });
      await expect(service().isFriend('u1', 'u2')).resolves.toBe(true);
    });
  });

  describe('setNotifyOnLive', () => {
    it('404s when not following that user', async () => {
      prisma.follow.updateMany.mockResolvedValue({ count: 0 });
      await expect(service().setNotifyOnLive('u1', 'u2', false)).rejects.toThrow(NotFoundException);
    });

    it('updates the bell when already following', async () => {
      prisma.follow.updateMany.mockResolvedValue({ count: 1 });
      await expect(service().setNotifyOnLive('u1', 'u2', false)).resolves.toEqual({ ok: true });
      expect(prisma.follow.updateMany).toHaveBeenCalledWith({
        where: { followerId: 'u1', followeeId: 'u2' },
        data: { notifyOnLive: false },
      });
    });
  });

  describe('getRelationshipSummary', () => {
    it('reports mutual follows as a friend', async () => {
      prisma.follow.count.mockResolvedValueOnce(10).mockResolvedValueOnce(4);
      prisma.follow.findMany.mockResolvedValue([{ followerId: 'me' }, { followerId: 'them' }]);

      const summary = await service().getRelationshipSummary('them', 'me');

      expect(summary).toEqual({
        followerCount: 10,
        followingCount: 4,
        isFollowing: true,
        isFollowedBy: true,
        isFriend: true,
        notifyOnLive: false,
        isBlocked: false,
        isMutedInChat: false,
      });
    });

    it('reports isMutedInChat when this viewer muted the profile in chat', async () => {
      prisma.follow.count.mockResolvedValue(0);
      prisma.follow.findMany.mockResolvedValue([]);
      prisma.personalChatMute.findUnique.mockResolvedValueOnce({ id: 'm1' });

      const summary = await service().getRelationshipSummary('them', 'me');

      expect(summary.isMutedInChat).toBe(true);
      expect(prisma.personalChatMute.findUnique).toHaveBeenCalledWith({
        where: { userId_mutedUserId: { userId: 'me', mutedUserId: 'them' } },
        select: { id: true },
      });
    });

    it('reports isBlocked when this viewer specifically has blocked the profile', async () => {
      prisma.follow.count.mockResolvedValue(0);
      prisma.follow.findMany.mockResolvedValue([]);
      prisma.block.findUnique.mockResolvedValueOnce({ id: 'b1' });

      const summary = await service().getRelationshipSummary('them', 'me');

      expect(summary.isBlocked).toBe(true);
      expect(prisma.block.findUnique).toHaveBeenCalledWith({
        where: { blockerId_blockedId: { blockerId: 'me', blockedId: 'them' } },
        select: { id: true },
      });
    });

    it('skips the relation and block lookups for a signed-out viewer or your own profile', async () => {
      prisma.follow.count.mockResolvedValue(0);

      await service().getRelationshipSummary('me', undefined);
      await service().getRelationshipSummary('me', 'me');

      expect(prisma.follow.findMany).not.toHaveBeenCalled();
      expect(prisma.block.findUnique).not.toHaveBeenCalled();
      expect(prisma.personalChatMute.findUnique).not.toHaveBeenCalled();
    });

    it('a one-way follow is not a friend', async () => {
      prisma.follow.count.mockResolvedValue(0);
      prisma.follow.findMany.mockResolvedValue([{ followerId: 'me' }]);

      const summary = await service().getRelationshipSummary('them', 'me');

      expect(summary).toMatchObject({ isFollowing: true, isFollowedBy: false, isFriend: false });
    });

    it("reports this viewer's own notifyOnLive bell state, not the other side's", async () => {
      prisma.follow.count.mockResolvedValue(0);
      prisma.follow.findMany.mockResolvedValue([
        { followerId: 'me', notifyOnLive: true },
        { followerId: 'them', notifyOnLive: false },
      ]);

      const summary = await service().getRelationshipSummary('them', 'me');

      expect(summary.notifyOnLive).toBe(true);
    });
  });

  describe('lists', () => {
    const row = (id: string, userId: string) => ({
      id,
      follower: { id: userId },
      followee: { id: userId },
    });
    const owner = (profileVisibility: ProfileVisibility) =>
      prisma.user.findUnique.mockResolvedValueOnce({ profileVisibility });

    beforeEach(() => prisma.block.findMany.mockResolvedValue([]));

    it('pages followers, newest first, with a cursor for the next page', async () => {
      owner(ProfileVisibility.EVERYONE);
      prisma.follow.findMany.mockResolvedValue([row('3', 'a'), row('2', 'b'), row('1', 'c')]);

      const page = await service().listFollowers('host', 'me', undefined, 2);

      expect(page.items).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBe('2');
      expect(prisma.follow.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { followeeId: 'host' }, take: 3 }),
      );
    });

    it('the last page reports no more and no cursor', async () => {
      owner(ProfileVisibility.EVERYONE);
      prisma.follow.findMany.mockResolvedValue([row('1', 'a')]);

      const page = await service().listFollowing('host', undefined, undefined, 5);

      expect(page).toEqual({ items: [{ id: 'a' }], hasMore: false, nextCursor: null });
    });

    it('leaves out anyone blocked either way with the viewer', async () => {
      prisma.block.findMany.mockResolvedValue([
        { blockerId: 'me', blockedId: 'x' },
        { blockerId: 'y', blockedId: 'me' },
      ]);
      prisma.follow.findMany.mockResolvedValue([]);

      owner(ProfileVisibility.EVERYONE);
      await service().listFollowers('host', 'me');
      owner(ProfileVisibility.EVERYONE);
      await service().listFollowing('host', 'me');

      expect(prisma.follow.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { followeeId: 'host', followerId: { notIn: ['x', 'y'] } },
        }),
      );
      expect(prisma.follow.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { followerId: 'host', followeeId: { notIn: ['x', 'y'] } },
        }),
      );
    });

    it("keeps a friends-only profile's lists from someone who is only a follower", async () => {
      owner(ProfileVisibility.FRIENDS);
      // me -> host, but not back.
      prisma.follow.findUnique.mockImplementation(
        ({ where }: { where: { followerId_followeeId: { followerId: string } } }) =>
          Promise.resolve(
            where.followerId_followeeId.followerId === 'me' ? { followerId: 'me' } : null,
          ),
      );

      const error = await service()
        .listFollowers('host', 'me')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toEqual(
        expect.objectContaining({ code: 'PROFILE_PRIVATE' }),
      );
      expect(prisma.follow.findMany).not.toHaveBeenCalled();
    });

    it("shows a friends-only profile's lists to a friend", async () => {
      owner(ProfileVisibility.FRIENDS);
      prisma.follow.findUnique.mockResolvedValue({ followerId: 'x' });
      prisma.follow.findMany.mockResolvedValue([]);

      await expect(service().listFollowing('host', 'me')).resolves.toEqual(
        expect.objectContaining({ items: [] }),
      );
    });

    it('always shows people their own lists, even when only they can see their profile', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        profileVisibility: ProfileVisibility.ONLY_ME,
      });
      prisma.follow.findMany.mockResolvedValue([]);

      await expect(service().listFollowers('me', 'me')).resolves.toEqual(
        expect.objectContaining({ items: [] }),
      );
    });

    it('treats a signed-out visitor as a stranger', async () => {
      owner(ProfileVisibility.FOLLOWERS);
      await expect(service().listFollowers('host', undefined)).rejects.toThrow(ForbiddenException);
    });

    it('404s for someone the owner blocked, like the profile itself', async () => {
      owner(ProfileVisibility.EVERYONE);
      prisma.block.findUnique.mockResolvedValueOnce({ id: 'b1' });

      await expect(service().listFollowers('host', 'me')).rejects.toThrow(NotFoundException);
      expect(prisma.follow.findMany).not.toHaveBeenCalled();
    });

    it('404s for someone who does not exist', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await expect(service().listFollowers('ghost', 'me')).rejects.toThrow(NotFoundException);
    });

    it('friends requires the follow to go both ways', async () => {
      prisma.follow.findMany.mockResolvedValue([]);

      await service().listFriends('me', 'c1', 10);

      expect(prisma.follow.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            followerId: 'me',
            followee: { following: { some: { followeeId: 'me' } } },
            id: { lt: 'c1' },
          },
        }),
      );
    });
  });

  describe('search', () => {
    it('returns an empty page for a blank query without touching the database', async () => {
      await expect(service().search('   ', 'me')).resolves.toEqual({
        items: [],
        hasMore: false,
        nextCursor: null,
      });
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('excludes the requester and only active accounts, paging by username', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: '1', username: 'ann' },
        { id: '2', username: 'anna' },
      ]);

      const page = await service().search('an', 'me', undefined, 1);

      expect(page).toEqual({
        items: [{ id: '1', username: 'ann' }],
        hasMore: true,
        nextCursor: 'ann',
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: UserStatus.ACTIVE,
            id: { notIn: ['me'] },
            OR: [
              { username: { startsWith: 'an', mode: 'insensitive' } },
              { displayName: { startsWith: 'an', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('also excludes anyone blocked either way', async () => {
      prisma.block.findMany.mockResolvedValueOnce([{ blockerId: 'me', blockedId: 'blocked-1' }]);
      prisma.user.findMany.mockResolvedValue([]);

      await service().search('an', 'me');

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { notIn: ['me', 'blocked-1'] } }),
        }),
      );
    });
  });
});
