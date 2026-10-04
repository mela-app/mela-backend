import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProfileVisibility, StreamStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageProvider } from '../common/storage/storage-provider.interface';
import { SocialService } from '../social/social.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
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
        select: { id: true },
      });
      expect(profile).toEqual({ ...profileRow, ...relationship, canViewProfile: true, liveStreamId: null });
    });

    describe('profile visibility', () => {
      const friendsOnly = { ...profileRow, bio: 'Poker nights', profileVisibility: ProfileVisibility.FRIENDS };

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
        social.getRelationshipSummary.mockResolvedValue({ ...relationship, isFollowing: true, isFollowedBy: true, isFriend: true });

        const profile = await service().findPublicProfile('u1', 'viewer-1');

        expect(profile).toEqual(expect.objectContaining({ canViewProfile: true, bio: 'Poker nights', followerCount: 3 }));
      });

      it('always shows people their own profile, without a block lookup', async () => {
        prisma.user.findUnique.mockResolvedValue({ ...friendsOnly, profileVisibility: ProfileVisibility.ONLY_ME });

        const profile = await service().findPublicProfile('u1', 'u1');

        expect(profile).toEqual(
          expect.objectContaining({ canViewProfile: true, profileVisibility: ProfileVisibility.ONLY_ME, bio: 'Poker nights' }),
        );
        expect(social.isBlockedByViewer).not.toHaveBeenCalled();
      });

      it("404s for someone the owner blocked, as if the account didn't exist", async () => {
        prisma.user.findUnique.mockResolvedValue(profileRow);
        prisma.stream.findFirst.mockResolvedValue({ id: 'stream-1' });
        social.isBlockedByViewer.mockResolvedValue(true);

        await expect(service().findPublicProfile('u1', 'viewer-1')).rejects.toThrow(NotFoundException);
        expect(social.isBlockedByViewer).toHaveBeenCalledWith('u1', 'viewer-1');
      });

      it("doesn't offer the live of someone this viewer blocked", async () => {
        prisma.user.findUnique.mockResolvedValue(profileRow);
        prisma.stream.findFirst.mockResolvedValue({ id: 'stream-1' });
        social.getRelationshipSummary.mockResolvedValue({ ...relationship, isBlocked: true });

        const profile = await service().findPublicProfile('u1', 'viewer-1');

        expect(profile).toEqual(expect.objectContaining({ isBlocked: true, liveStreamId: null }));
      });
    });

    it('surfaces the current live id when the profile is live', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow);
      prisma.stream.findFirst.mockResolvedValue({ id: 'stream-1' });

      const profile = await service().findPublicProfile('u1');

      expect(profile.liveStreamId).toBe('stream-1');
    });
  });

  describe('updateOwnProfile', () => {
    it('passes the dto straight through to Prisma', async () => {
      prisma.user.update.mockResolvedValue(profileRow);
      await service().updateOwnProfile('u1', { bio: 'hi' });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1' }, data: { bio: 'hi' } }),
      );
    });
  });

  describe('createAvatarUploadUrl', () => {
    it('keys the object under the user id with an extension matching the content type', async () => {
      storage.createUploadUrl.mockResolvedValue({ uploadUrl: 'https://put', publicUrl: 'https://get' });

      const result = await service().createAvatarUploadUrl('u1', 'image/png');

      expect(result).toEqual({ uploadUrl: 'https://put', publicUrl: 'https://get' });
      const [key, contentType] = storage.createUploadUrl.mock.calls[0];
      expect(key).toMatch(/^avatars\/u1\/.+\.png$/);
      expect(contentType).toBe('image/png');
    });

    it('defaults to a .jpg key for anything else the DTO allowed through', async () => {
      storage.createUploadUrl.mockResolvedValue({ uploadUrl: 'https://put', publicUrl: 'https://get' });

      await service().createAvatarUploadUrl('u1', 'image/jpeg');

      const [key] = storage.createUploadUrl.mock.calls[0];
      expect(key).toMatch(/\.jpg$/);
    });
  });
});
