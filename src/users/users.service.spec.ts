import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProfileSharing, ProfileVisibility, StreamStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageProvider } from '../common/storage/storage-provider.interface';
import { SocialService } from '../social/social.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  const prisma = {
    user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    stream: { findFirst: jest.fn() },
  };
  const social = { getRelationshipSummary: jest.fn(), isBlockedByViewer: jest.fn() };
  const storage = { createUploadUrl: jest.fn() };
  const events = { emit: jest.fn() };

  const service = () =>
    new UsersService(
      prisma as unknown as PrismaService,
      social as unknown as SocialService,
      storage as unknown as StorageProvider,
      events as unknown as EventEmitter2,
    );

  const profileRow = {
    id: 'u1',
    username: 'ana',
    displayName: 'Ana',
    avatarUrl: null,
    bio: null,
    createdAt: new Date('2026-01-01'),
    profileVisibility: ProfileVisibility.EVERYONE,
    profileSharing: ProfileSharing.EVERYONE,
  };
  const relationship = {
    followerCount: 3,
    followingCount: 1,
    isFollowing: false,
    isFollowedBy: false,
    isFriend: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    social.getRelationshipSummary.mockResolvedValue(relationship);
    social.isBlockedByViewer.mockResolvedValue(false);
    prisma.stream.findFirst.mockResolvedValue(null);
  });

  describe('findPublicProfile', () => {
    it('404s for an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service().findPublicProfile('ghost')).rejects.toThrow(NotFoundException);
    });

    it('merges relationship flags and liveStreamId (null when not live)', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow);

      const profile = await service().findPublicProfile('u1', 'viewer-1');

      expect(social.getRelationshipSummary).toHaveBeenCalledWith('u1', 'viewer-1');
      expect(prisma.stream.findFirst).toHaveBeenCalledWith({
        where: { hostId: 'u1', status: StreamStatus.LIVE },
        select: { id: true, visibility: true },
      });
      expect(profile).toEqual({
        ...profileRow,
        ...relationship,
        profileSharing: null,
        canViewProfile: true,
        canShare: true,
        liveStreamId: null,
      });
    });

    describe('profile sharing', () => {
      const friendsShare = { ...profileRow, profileSharing: ProfileSharing.FRIENDS };

      it('lets only the people the owner chose share it, without telling them the setting', async () => {
        prisma.user.findUnique.mockResolvedValue(friendsShare);
        social.getRelationshipSummary.mockResolvedValue({ ...relationship, isFollowing: true });

        const follower = await service().findPublicProfile('u1', 'viewer-1');

        expect(follower).toEqual(
          expect.objectContaining({ canShare: false, profileSharing: null }),
        );

        social.getRelationshipSummary.mockResolvedValue({
          ...relationship,
          isFollowing: true,
          isFollowedBy: true,
          isFriend: true,
        });
        const friend = await service().findPublicProfile('u1', 'viewer-2');

        expect(friend).toEqual(expect.objectContaining({ canShare: true, profileSharing: null }));
      });

      it('shows the owner their own setting, and always lets them share', async () => {
        prisma.user.findUnique.mockResolvedValue({
          ...friendsShare,
          profileSharing: ProfileSharing.ONLY_ME,
        });

        const profile = await service().findPublicProfile('u1', 'u1');

        expect(profile).toEqual(
          expect.objectContaining({ canShare: true, profileSharing: ProfileSharing.ONLY_ME }),
        );
      });
    });

    describe('profile visibility', () => {
      const friendsOnly = {
        ...profileRow,
        bio: 'Poker nights',
        profileVisibility: ProfileVisibility.FRIENDS,
      };

      it('keeps the details from someone the owner does not allow, but not who they are', async () => {
        prisma.user.findUnique.mockResolvedValue(friendsOnly);
        social.getRelationshipSummary.mockResolvedValue({ ...relationship, isFollowing: true });

        const profile = await service().findPublicProfile('u1', 'viewer-1');

        expect(profile).toEqual(
          expect.objectContaining({
            username: 'ana',
            displayName: 'Ana',
            profileVisibility: ProfileVisibility.FRIENDS,
            canViewProfile: false,
            bio: null,
            createdAt: null,
            followerCount: null,
            followingCount: null,
            isFollowing: true,
          }),
        );
      });

      it('shows them to a friend', async () => {
        prisma.user.findUnique.mockResolvedValue(friendsOnly);
        social.getRelationshipSummary.mockResolvedValue({
          ...relationship,
          isFollowing: true,
          isFollowedBy: true,
          isFriend: true,
        });

        const profile = await service().findPublicProfile('u1', 'viewer-1');

        expect(profile).toEqual(
          expect.objectContaining({ canViewProfile: true, bio: 'Poker nights', followerCount: 3 }),
        );
      });

      it('always shows people their own profile, without a block lookup', async () => {
        prisma.user.findUnique.mockResolvedValue({
          ...friendsOnly,
          profileVisibility: ProfileVisibility.ONLY_ME,
        });

        const profile = await service().findPublicProfile('u1', 'u1');

        expect(profile).toEqual(
          expect.objectContaining({
            canViewProfile: true,
            profileVisibility: ProfileVisibility.ONLY_ME,
            bio: 'Poker nights',
          }),
        );
        expect(social.isBlockedByViewer).not.toHaveBeenCalled();
      });

      it("404s for someone the owner blocked, as if the account didn't exist", async () => {
        prisma.user.findUnique.mockResolvedValue(profileRow);
        prisma.stream.findFirst.mockResolvedValue({ id: 'stream-1', visibility: 'PUBLIC' });
        social.isBlockedByViewer.mockResolvedValue(true);

        await expect(service().findPublicProfile('u1', 'viewer-1')).rejects.toThrow(
          NotFoundException,
        );
        expect(social.isBlockedByViewer).toHaveBeenCalledWith('u1', 'viewer-1');
      });

      it("doesn't offer the live of someone this viewer blocked", async () => {
        prisma.user.findUnique.mockResolvedValue(profileRow);
        prisma.stream.findFirst.mockResolvedValue({ id: 'stream-1', visibility: 'PUBLIC' });
        social.getRelationshipSummary.mockResolvedValue({ ...relationship, isBlocked: true });

        const profile = await service().findPublicProfile('u1', 'viewer-1');

        expect(profile).toEqual(expect.objectContaining({ isBlocked: true, liveStreamId: null }));
      });
    });

    it("keeps a followers' or friends' live off the profile for who may not watch it", async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow);
      prisma.stream.findFirst.mockResolvedValue({ id: 'stream-1', visibility: 'FRIENDS' });

      await expect(service().findPublicProfile('u1', 'viewer-1')).resolves.toMatchObject({
        liveStreamId: null,
      });

      social.getRelationshipSummary.mockResolvedValue({
        ...relationship,
        isFollowing: true,
        isFollowedBy: true,
        isFriend: true,
      });
      await expect(service().findPublicProfile('u1', 'viewer-1')).resolves.toMatchObject({
        liveStreamId: 'stream-1',
      });
    });

    it('surfaces the current live id when the profile is live', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow);
      prisma.stream.findFirst.mockResolvedValue({ id: 'stream-1', visibility: 'PUBLIC' });

      const profile = await service().findPublicProfile('u1');

      expect(profile.liveStreamId).toBe('stream-1');
    });
  });

  describe('updateOwnProfile', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const names = (usernameChangedAt: Date | null, displayNameChangedAt: Date | null) => ({
      username: 'ana',
      displayName: 'Ana',
      usernameChangedAt,
      displayNameChangedAt,
    });

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(names(null, null));
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.update.mockImplementation(({ data }: { data: object }) =>
        Promise.resolve({ ...profileRow, ...names(null, null), ...data }),
      );
    });

    it('passes the rest of the dto straight through to Prisma', async () => {
      await service().updateOwnProfile('u1', { bio: 'hi' }, now);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1' }, data: { bio: 'hi' } }),
      );
    });

    it('changes the username and the display name, noting when, and says when they may change again', async () => {
      const result = await service().updateOwnProfile(
        'u1',
        { username: 'ana_live', displayName: 'Ana B' },
        now,
      );

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            username: 'ana_live',
            usernameChangedAt: now,
            displayName: 'Ana B',
            displayNameChangedAt: now,
          },
        }),
      );
      expect(result.usernameChangeableAt).toEqual(new Date('2026-11-11T12:00:00Z'));
      expect(result.displayNameChangeableAt).toEqual(new Date('2026-10-19T12:00:00Z'));
      expect(result).not.toHaveProperty('usernameChangedAt');
    });

    it('a username once in 30 days', async () => {
      prisma.user.findUnique.mockResolvedValue(names(daysAgo(29), null));
      await expect(
        service().updateOwnProfile('u1', { username: 'ana_live' }, now),
      ).rejects.toMatchObject({
        response: {
          code: 'USERNAME_CHANGE_TOO_SOON',
          message: 'You can change your username again on 2026-10-13',
        },
      });

      prisma.user.findUnique.mockResolvedValue(names(daysAgo(31), null));
      await expect(
        service().updateOwnProfile('u1', { username: 'ana_live' }, now),
      ).resolves.toBeDefined();
    });

    it('a display name once in 7 days', async () => {
      prisma.user.findUnique.mockResolvedValue(names(null, daysAgo(6)));
      await expect(
        service().updateOwnProfile('u1', { displayName: 'Ana B' }, now),
      ).rejects.toMatchObject({ response: { code: 'DISPLAY_NAME_CHANGE_TOO_SOON' } });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("sending the current names again isn't a change, and isn't counted", async () => {
      prisma.user.findUnique.mockResolvedValue(names(daysAgo(1), daysAgo(1)));

      await service().updateOwnProfile(
        'u1',
        { username: 'ana', displayName: 'Ana', bio: 'x' },
        now,
      );

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { bio: 'x' } }),
      );
    });

    it('refuses a username someone else has, whatever its case', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u2' });

      await expect(service().updateOwnProfile('u1', { username: 'Kebede' }, now)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { username: { equals: 'Kebede', mode: 'insensitive' }, id: { not: 'u1' } },
        select: { id: true },
      });
    });
  });

  describe('createAvatarUploadUrl', () => {
    it('keys the object under the user id with an extension matching the content type', async () => {
      storage.createUploadUrl.mockResolvedValue({
        uploadUrl: 'https://put',
        publicUrl: 'https://get',
      });

      const result = await service().createAvatarUploadUrl('u1', 'image/png');

      expect(result).toEqual({ uploadUrl: 'https://put', publicUrl: 'https://get' });
      const [key, contentType] = storage.createUploadUrl.mock.calls[0];
      expect(key).toMatch(/^avatars\/u1\/.+\.png$/);
      expect(contentType).toBe('image/png');
    });

    it('defaults to a .jpg key for anything else the DTO allowed through', async () => {
      storage.createUploadUrl.mockResolvedValue({
        uploadUrl: 'https://put',
        publicUrl: 'https://get',
      });

      await service().createAvatarUploadUrl('u1', 'image/jpeg');

      const [key] = storage.createUploadUrl.mock.calls[0];
      expect(key).toMatch(/\.jpg$/);
    });
  });
});
