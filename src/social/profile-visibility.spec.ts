import { ProfileVisibility } from '@prisma/client';
import { canViewProfileDetails, ProfileViewer, visibilityShownTo } from './profile-visibility';

describe('profile visibility', () => {
  const stranger: ProfileViewer = { isSelf: false, isFollower: false, isFriend: false, blockedByOwner: false };
  const follower: ProfileViewer = { ...stranger, isFollower: true };
  const friend: ProfileViewer = { ...stranger, isFollower: true, isFriend: true };
  const self: ProfileViewer = { ...stranger, isSelf: true };
  const blocked: ProfileViewer = { ...friend, blockedByOwner: true };

  it.each([
    [ProfileVisibility.EVERYONE, [true, true, true]],
    [ProfileVisibility.FOLLOWERS, [false, true, true]],
    [ProfileVisibility.FRIENDS, [false, false, true]],
    [ProfileVisibility.ONLY_ME, [false, false, false]],
  ])('%s: a stranger, a follower and a friend see the details %j', (visibility, expected) => {
    expect([stranger, follower, friend].map((viewer) => canViewProfileDetails(visibility, viewer))).toEqual(expected);
  });

  it('always shows people their own profile', () => {
    for (const visibility of Object.values(ProfileVisibility)) {
      expect(canViewProfileDetails(visibility, self)).toBe(true);
    }
  });

  it("hides the details from someone the owner blocked, and tells them it's just private", () => {
    expect(canViewProfileDetails(ProfileVisibility.EVERYONE, blocked)).toBe(false);
    expect(visibilityShownTo(ProfileVisibility.EVERYONE, blocked)).toBe(ProfileVisibility.ONLY_ME);
    expect(visibilityShownTo(ProfileVisibility.FRIENDS, friend)).toBe(ProfileVisibility.FRIENDS);
  });
});
