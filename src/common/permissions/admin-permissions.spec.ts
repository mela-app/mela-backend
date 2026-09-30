import { AdminPermission, PlatformRole } from '@prisma/client';
import { ALL_ADMIN_PERMISSIONS, effectiveAdminPermissions, withIncludedPermissions } from './admin-permissions';

describe('admin permissions', () => {
  it('adds what a permission includes, once, in a stable order', () => {
    expect(
      withIncludedPermissions([AdminPermission.MANAGE_USERS, AdminPermission.VIEW_USERS, AdminPermission.VIEW_LIVES]),
    ).toEqual([AdminPermission.VIEW_LIVES, AdminPermission.VIEW_USERS, AdminPermission.MANAGE_USERS]);
  });

  it('lets alerting everyone include alerting one live and seeing alerts', () => {
    expect(withIncludedPermissions([AdminPermission.SEND_GLOBAL_ALERTS])).toEqual([
      AdminPermission.VIEW_ALERTS,
      AdminPermission.SEND_ALERTS,
      AdminPermission.SEND_GLOBAL_ALERTS,
    ]);
  });

  it('gives a super admin everything, whatever is stored', () => {
    expect(effectiveAdminPermissions(PlatformRole.SUPER_ADMIN, [])).toEqual([...ALL_ADMIN_PERMISSIONS]);
  });

  it('gives a platform moderator only what they were given', () => {
    expect(effectiveAdminPermissions(PlatformRole.PLATFORM_MODERATOR, [])).toEqual([]);
    expect(effectiveAdminPermissions(PlatformRole.PLATFORM_MODERATOR, [AdminPermission.MANAGE_LIVES])).toEqual([
      AdminPermission.VIEW_LIVES,
      AdminPermission.MANAGE_LIVES,
    ]);
  });

  it('never gives an app user console access, even with stale permissions stored', () => {
    expect(effectiveAdminPermissions(PlatformRole.USER, [AdminPermission.MANAGE_USERS])).toEqual([]);
  });
});
