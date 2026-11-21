import { AdminPermission, PlatformRole, UserStatus } from '@prisma/client';

/**
 * Mela's safety team watching lives unseen (docs/features/streams.md,
 * "Staff watching"): a super admin, or a platform moderator who may see
 * lives, watches anyone's live - followers' and friends' lives too, whatever
 * blocks or bans - and nobody in it can tell: no "joined", no viewer counted,
 * not in the viewer list, hidden in the video room. They only watch: no
 * chat, likes or stage while hidden. Every watch is in the audit log.
 */
export function canWatchHidden(
  user: {
    platformRole: PlatformRole;
    adminPermissions: AdminPermission[];
    status: UserStatus;
  } | null,
): boolean {
  if (!user || user.status !== UserStatus.ACTIVE) return false;
  if (user.platformRole === PlatformRole.SUPER_ADMIN) return true;
  return (
    user.platformRole === PlatformRole.PLATFORM_MODERATOR &&
    (user.adminPermissions.includes(AdminPermission.VIEW_LIVES) ||
      user.adminPermissions.includes(AdminPermission.MANAGE_LIVES))
  );
}

/** What staff are told when they try to take part in a live they're watching unseen. */
export const STAFF_WATCH_REFUSAL = {
  message: "You're watching as Mela staff - nobody can see you, so you can't take part.",
  code: 'STAFF_WATCHING',
} as const;
