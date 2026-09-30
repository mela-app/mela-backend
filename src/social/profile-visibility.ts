import { ProfileVisibility } from '@prisma/client';

/** How the person looking at a profile relates to its owner. */
export interface ProfileViewer {
  isSelf: boolean;
  /** Follows the owner. */
  isFollower: boolean;
  /** Follows the owner, and is followed back. */
  isFriend: boolean;
  /** The owner blocked them. */
  blockedByOwner: boolean;
}

/**
 * Whether [viewer] may see a profile's details - bio, follower counts and
 * follow lists. Name, username and picture are always public: they show in
 * every chat and viewer list anyway.
 */
export function canViewProfileDetails(visibility: ProfileVisibility, viewer: ProfileViewer): boolean {
  if (viewer.isSelf) return true;
  if (viewer.blockedByOwner) return false;
  switch (visibility) {
    case ProfileVisibility.EVERYONE:
      return true;
    case ProfileVisibility.FOLLOWERS:
      return viewer.isFollower;
    case ProfileVisibility.FRIENDS:
      return viewer.isFriend;
    case ProfileVisibility.ONLY_ME:
      return false;
  }
}

/**
 * The setting as this viewer is told it. Someone the owner blocked just
 * sees a private profile - never that they were blocked.
 */
export function visibilityShownTo(visibility: ProfileVisibility, viewer: ProfileViewer): ProfileVisibility {
  return viewer.blockedByOwner && !viewer.isSelf ? ProfileVisibility.ONLY_ME : visibility;
}
