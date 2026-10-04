import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StreamStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DomainEvents, UserProfileUpdatedPayload } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../common/storage/storage-provider.interface';
import { canViewProfileDetails, ProfileViewer, visibilityShownTo } from '../social/profile-visibility';
import { SocialService } from '../social/social.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

const PUBLIC_PROFILE_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  createdAt: true,
  profileVisibility: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly social: SocialService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * [requesterId] adds isFollowing/isFollowedBy/isFriend for that viewer - omit it for a signed-out one.
   * The details (bio, counts) are null unless the owner's profile visibility lets this viewer see them.
   * Someone the owner blocked gets a 404, as if the account didn't exist (plan §6.4).
   */
  async findPublicProfile(id: string, requesterId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: PUBLIC_PROFILE_SELECT,
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const isSelf = requesterId === id;
    const [relationship, liveStream, blockedByOwner] = await Promise.all([
      this.social.getRelationshipSummary(id, requesterId),
      this.prisma.stream.findFirst({ where: { hostId: id, status: StreamStatus.LIVE }, select: { id: true } }),
      requesterId && !isSelf ? this.social.isBlockedByViewer(id, requesterId) : Promise.resolve(false),
    ]);
    if (blockedByOwner) {
      throw new NotFoundException('User not found');
    }
    const viewer: ProfileViewer = {
      isSelf,
      isFollower: relationship.isFollowing,
      isFriend: relationship.isFriend,
      blockedByOwner,
    };
    const canViewProfile = canViewProfileDetails(user.profileVisibility, viewer);
    const { followerCount, followingCount, ...relation } = relationship;
    return {
      ...user,
      profileVisibility: visibilityShownTo(user.profileVisibility, viewer),
      canViewProfile,
      bio: canViewProfile ? user.bio : null,
      createdAt: canViewProfile ? user.createdAt : null,
      followerCount: canViewProfile ? followerCount : null,
      followingCount: canViewProfile ? followingCount : null,
      ...relation,
      // Someone this viewer blocked can't be watched either.
      liveStreamId: relation.isBlocked ? null : (liveStream?.id ?? null),
    };
  }

  async updateOwnProfile(id: string, dto: UpdateProfileDto) {
    const updated = await this.prisma.user.update({
      where: { id },
      data: dto,
      select: PUBLIC_PROFILE_SELECT,
    });
    const fields = Object.keys(dto).filter((key) => dto[key as keyof UpdateProfileDto] !== undefined);
    if (fields.length > 0) {
      this.events.emit(DomainEvents.UserProfileUpdated, { userId: id, fields } satisfies UserProfileUpdatedPayload);
    }
    return updated;
  }

  /** A short-lived direct-upload URL for a new avatar - the API never sees the image bytes. */
  async createAvatarUploadUrl(userId: string, contentType: string) {
    const extension = contentType === 'image/png' ? 'png' : 'jpg';
    const key = `avatars/${userId}/${randomUUID()}.${extension}`;
    return this.storage.createUploadUrl(key, contentType);
  }
}
