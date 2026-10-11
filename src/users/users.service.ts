import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, StreamStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DomainEvents, UserProfileUpdatedPayload } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../common/storage/storage-provider.interface';
import { canShareProfile } from '../social/profile-sharing';
import {
  canViewProfileDetails,
  ProfileViewer,
  visibilityShownTo,
} from '../social/profile-visibility';
import { SocialService } from '../social/social.service';
import { canWatchLive } from '../streams/live-audience';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  DISPLAY_NAME_CHANGE_DAYS,
  nextNameChangeAt,
  USERNAME_CHANGE_DAYS,
} from './name-change-rules';

const PUBLIC_PROFILE_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  createdAt: true,
  profileVisibility: true,
  profileSharing: true,
} as const;

const NAME_CHANGE_SELECT = {
  username: true,
  displayName: true,
  usernameChangedAt: true,
  displayNameChangedAt: true,
} as const;

// The owner's own profile: also when each name may change again, and
// whether followers hear when they join a live.
const OWN_PROFILE_SELECT = {
  ...PUBLIC_PROFILE_SELECT,
  ...NAME_CHANGE_SELECT,
  shareLiveJoins: true,
} as const;

/** Swaps when the names changed for when they may change again (null: now). */
function withNameChangeDates<
  T extends { usernameChangedAt: Date | null; displayNameChangedAt: Date | null },
>(profile: T, now = new Date()) {
  const { usernameChangedAt, displayNameChangedAt, ...rest } = profile;
  return {
    ...rest,
    usernameChangeableAt: nextNameChangeAt(usernameChangedAt, USERNAME_CHANGE_DAYS, now),
    displayNameChangeableAt: nextNameChangeAt(displayNameChangedAt, DISPLAY_NAME_CHANGE_DAYS, now),
  };
}

function tooSoon(what: 'username' | 'display name', next: Date): BadRequestException {
  const date = next.toISOString().slice(0, 10);
  return new BadRequestException({
    message: `You can change your ${what} again on ${date}`,
    code: what === 'username' ? 'USERNAME_CHANGE_TOO_SOON' : 'DISPLAY_NAME_CHANGE_TOO_SOON',
    nextChangeAt: next.toISOString(),
  });
}

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
   * The details (bio, counts) are null unless the owner's profile visibility lets this viewer see them;
   * canShare says whether the owner lets this viewer share the profile, whose setting only they see.
   * Someone the owner blocked gets a 404, as if the account didn't exist (plan §6.4).
   */
  async findPublicProfile(id: string, requesterId?: string) {
    const row = await this.prisma.user.findUnique({
      where: { id },
      select: OWN_PROFILE_SELECT,
    });
    if (!row) {
      throw new NotFoundException('User not found');
    }
    const isSelf = requesterId === id;
    // Only the owner learns when their names may change again.
    const { usernameChangedAt, displayNameChangedAt, shareLiveJoins, ...user } = row;
    const ownNameDates = isSelf
      ? (({ usernameChangeableAt, displayNameChangeableAt }) => ({
          usernameChangeableAt,
          displayNameChangeableAt,
          shareLiveJoins,
        }))(withNameChangeDates({ usernameChangedAt, displayNameChangedAt }))
      : {};
    const [relationship, liveStream, blockedByOwner] = await Promise.all([
      this.social.getRelationshipSummary(id, requesterId),
      this.prisma.stream.findFirst({
        where: { hostId: id, status: StreamStatus.LIVE },
        select: { id: true, visibility: true },
      }),
      requesterId && !isSelf
        ? this.social.isBlockedByViewer(id, requesterId)
        : Promise.resolve(false),
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
      ...ownNameDates,
      profileVisibility: visibilityShownTo(user.profileVisibility, viewer),
      profileSharing: isSelf ? user.profileSharing : null,
      canViewProfile,
      canShare: canShareProfile(user.profileSharing, user.profileVisibility, viewer),
      bio: canViewProfile ? user.bio : null,
      createdAt: canViewProfile ? user.createdAt : null,
      followerCount: canViewProfile ? followerCount : null,
      followingCount: canViewProfile ? followingCount : null,
      ...relation,
      // Someone this viewer blocked can't be watched either, nor a followers'
      // or friends' live by anyone else (docs/features/streams.md).
      liveStreamId:
        relation.isBlocked ||
        !liveStream ||
        !canWatchLive(liveStream.visibility, {
          isHost: isSelf,
          follows: relationship.isFollowing,
          isFriend: relationship.isFriend,
        })
          ? null
          : liveStream.id,
    };
  }

  /**
   * The owner's own edit. A new username once in {@link USERNAME_CHANGE_DAYS}
   * days and a new display name once in {@link DISPLAY_NAME_CHANGE_DAYS}
   * (client request, 2026-10) - sending the current one again changes
   * nothing and isn't counted. Staff fixes in the console aren't limited.
   */
  async updateOwnProfile(id: string, dto: UpdateProfileDto, now = new Date()) {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: NAME_CHANGE_SELECT,
    });
    if (!current) throw new NotFoundException('User not found');
    const { username, displayName, ...rest } = dto;
    const data: Prisma.UserUpdateInput = { ...rest };

    if (username !== undefined && username !== current.username) {
      const next = nextNameChangeAt(current.usernameChangedAt, USERNAME_CHANGE_DAYS, now);
      if (next) throw tooSoon('username', next);
      const taken = await this.prisma.user.findFirst({
        where: { username: { equals: username, mode: 'insensitive' }, id: { not: id } },
        select: { id: true },
      });
      if (taken) throw new ConflictException('That username is taken');
      data.username = username;
      data.usernameChangedAt = now;
    }
    if (displayName !== undefined && displayName !== current.displayName) {
      const next = nextNameChangeAt(current.displayNameChangedAt, DISPLAY_NAME_CHANGE_DAYS, now);
      if (next) throw tooSoon('display name', next);
      data.displayName = displayName;
      data.displayNameChangedAt = now;
    }

    let updated: Prisma.UserGetPayload<{ select: typeof OWN_PROFILE_SELECT }>;
    try {
      updated = await this.prisma.user.update({ where: { id }, data, select: OWN_PROFILE_SELECT });
    } catch (error) {
      // Someone took it between the check and the write.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That username is taken');
      }
      throw error;
    }
    const fields = Object.keys(data).filter(
      (key) => key !== 'usernameChangedAt' && key !== 'displayNameChangedAt',
    );
    if (fields.length > 0) {
      this.events.emit(DomainEvents.UserProfileUpdated, {
        userId: id,
        fields,
      } satisfies UserProfileUpdatedPayload);
    }
    return withNameChangeDates(updated, now);
  }

  /** A short-lived direct-upload URL for a new avatar - the API never sees the image bytes. */
  async createAvatarUploadUrl(userId: string, contentType: string) {
    const extension = contentType === 'image/png' ? 'png' : 'jpg';
    const key = `avatars/${userId}/${randomUUID()}.${extension}`;
    return this.storage.createUploadUrl(key, contentType);
  }
}
