import { ProfileSharing, ProfileVisibility } from '@prisma/client';
import { canShareProfile } from './profile-sharing';
import { ProfileViewer } from './profile-visibility';

describe('profile sharing', () => {
  const stranger: ProfileViewer = {
    isSelf: false,
    isFollower: false,
    isFriend: false,
    blockedByOwner: false,
  };
  const follower: ProfileViewer = { ...stranger, isFollower: true };
  const friend: ProfileViewer = { ...stranger, isFollower: true, isFriend: true };
  const self: ProfileViewer = { ...stranger, isSelf: true };
  const blocked: ProfileViewer = { ...friend, blockedByOwner: true };

  it.each([
    [ProfileSharing.EVERYONE, [true, true, true]],
    [ProfileSharing.FOLLOWERS, [false, true, true]],
    [ProfileSharing.FRIENDS, [false, false, true]],
    [ProfileSharing.ONLY_ME, [false, false, false]],
  ])('%s: a stranger, a follower and a friend may share %j', (sharing, expected) => {
    expect(
      [stranger, follower, friend].map((viewer) =>
        canShareProfile(sharing, ProfileVisibility.EVERYONE, viewer),
      ),
    ).toEqual(expected);
  });

  it('always lets the owner share their own profile', () => {
    for (const sharing of Object.values(ProfileSharing)) {
      for (const visibility of Object.values(ProfileVisibility)) {
        expect(canShareProfile(sharing, visibility, self)).toBe(true);
      }
    }
  });

  it("never lets someone share a profile they can't see", () => {
    expect(canShareProfile(ProfileSharing.EVERYONE, ProfileVisibility.FRIENDS, follower)).toBe(
      false,
    );
    expect(canShareProfile(ProfileSharing.EVERYONE, ProfileVisibility.FRIENDS, friend)).toBe(true);
    expect(canShareProfile(ProfileSharing.EVERYONE, ProfileVisibility.ONLY_ME, friend)).toBe(false);
  });

  it('never lets someone the owner blocked share it', () => {
    expect(canShareProfile(ProfileSharing.EVERYONE, ProfileVisibility.EVERYONE, blocked)).toBe(
      false,
    );
  });
});
