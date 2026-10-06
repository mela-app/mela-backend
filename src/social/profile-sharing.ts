import { ProfileSharing, ProfileVisibility } from '@prisma/client';
import { canViewProfileDetails, ProfileViewer } from './profile-visibility';

/**
 * Whether [viewer] may share a profile's link with others (docs/features/share.md).
 * The owner always can. Anyone else needs the owner's [sharing] setting to
 * include them - and to be able to see the profile at all ([visibility]).
 */
export function canShareProfile(
  sharing: ProfileSharing,
  visibility: ProfileVisibility,
  viewer: ProfileViewer,
): boolean {
  if (viewer.isSelf) return true;
  if (!canViewProfileDetails(visibility, viewer)) return false;
  switch (sharing) {
    case ProfileSharing.EVERYONE:
      return true;
    case ProfileSharing.FOLLOWERS:
      return viewer.isFollower;
    case ProfileSharing.FRIENDS:
      return viewer.isFriend;
    case ProfileSharing.ONLY_ME:
      return false;
  }
}
