import { AdminPermission, PlatformRole, UserStatus } from '@prisma/client';
import { canWatchHidden } from './staff-watch';

describe('canWatchHidden', () => {
  const user = (
    platformRole: PlatformRole,
    adminPermissions: AdminPermission[] = [],
    status: UserStatus = UserStatus.ACTIVE,
  ) => ({ platformRole, adminPermissions, status });

  it('is for super admins, and moderators who may see lives', () => {
    expect(canWatchHidden(user(PlatformRole.SUPER_ADMIN))).toBe(true);
    expect(
      canWatchHidden(user(PlatformRole.PLATFORM_MODERATOR, [AdminPermission.VIEW_LIVES])),
    ).toBe(true);
    expect(
      canWatchHidden(user(PlatformRole.PLATFORM_MODERATOR, [AdminPermission.MANAGE_LIVES])),
    ).toBe(true);
  });

  it('is not for users, other moderators, or a suspended account', () => {
    expect(canWatchHidden(user(PlatformRole.USER))).toBe(false);
    expect(
      canWatchHidden(user(PlatformRole.PLATFORM_MODERATOR, [AdminPermission.VIEW_USERS])),
    ).toBe(false);
    expect(canWatchHidden(user(PlatformRole.SUPER_ADMIN, [], UserStatus.SUSPENDED))).toBe(false);
    expect(canWatchHidden(null)).toBe(false);
  });
});
