import { PlatformRole } from '@prisma/client';

/**
 * Mela's staff accounts (docs/features/social.md, "Staff accounts"): app users
 * can't follow them - so no live alerts from them, and no private messages,
 * which need a mutual follow. Staff can still follow people, and each other.
 */
export function isStaffRole(role: PlatformRole): boolean {
  return role !== PlatformRole.USER;
}

/** Whether someone with [followerRole] (null: signed out) may follow someone with [followeeRole]. */
export function mayFollow(followerRole: PlatformRole | null, followeeRole: PlatformRole): boolean {
  return !isStaffRole(followeeRole) || (followerRole !== null && isStaffRole(followerRole));
}

export const STAFF_FOLLOW_REFUSAL = {
  message: "Mela staff accounts can't be followed",
  code: 'STAFF_ACCOUNT',
} as const;
