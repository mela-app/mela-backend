import { AdminPermission, PlatformRole } from '@prisma/client';

// A stronger permission includes the weaker ones in its area: managing users means seeing them.
const INCLUDES: Partial<Record<AdminPermission, readonly AdminPermission[]>> = {
  [AdminPermission.MANAGE_LIVES]: [AdminPermission.VIEW_LIVES],
  [AdminPermission.MANAGE_USERS]: [AdminPermission.VIEW_USERS],
  [AdminPermission.SEND_ALERTS]: [AdminPermission.VIEW_ALERTS],
  [AdminPermission.SEND_GLOBAL_ALERTS]: [AdminPermission.SEND_ALERTS, AdminPermission.VIEW_ALERTS],
  [AdminPermission.MANAGE_PHRASES]: [AdminPermission.VIEW_PHRASES],
};

export const ALL_ADMIN_PERMISSIONS: readonly AdminPermission[] = Object.values(AdminPermission);

/** [granted] plus everything it includes, once each, in the enum's order. */
export function withIncludedPermissions(granted: readonly AdminPermission[]): AdminPermission[] {
  const all = new Set(granted.flatMap((permission) => [permission, ...(INCLUDES[permission] ?? [])]));
  return ALL_ADMIN_PERMISSIONS.filter((permission) => all.has(permission));
}

/**
 * What an account may do in the admin console: everything for a super
 * admin, what a super admin gave them for a platform moderator, and
 * nothing for anyone else.
 */
export function effectiveAdminPermissions(role: PlatformRole, granted: readonly AdminPermission[]): AdminPermission[] {
  if (role === PlatformRole.SUPER_ADMIN) return [...ALL_ADMIN_PERMISSIONS];
  if (role === PlatformRole.PLATFORM_MODERATOR) return withIncludedPermissions(granted);
  return [];
}
