import { randomUUID } from 'crypto';
import { HostingAppealState, Prisma } from '@prisma/client';

/** After the team keeps a restriction, the host may write again this much later. */
export const APPEAL_AGAIN_AFTER_MS = 24 * 60 * 60 * 1000;
export const APPEAL_MAX_IMAGES = 3;
export const APPEAL_TEXT_MAX = 1000;
export const STAFF_TEXT_MAX = 1000;

/** The pictures an appeal may carry; the file extension follows the type. */
export const APPEAL_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' } as const;
export type AppealImageType = keyof typeof APPEAL_IMAGE_TYPES;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** In force at [now]: not lifted, and not past the time the team set. */
export function activeRestrictionWhere(now: Date): Prisma.HostingRestrictionWhereInput {
  return { liftedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] };
}

export type RestrictionStatus = 'ACTIVE' | 'LIFTED' | 'EXPIRED';

export function restrictionStatus(
  row: { liftedAt: Date | null; endsAt: Date | null },
  now: Date,
): RestrictionStatus {
  if (row.liftedAt) return 'LIFTED';
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

/**
 * When the host may write (appeal, or answer the team): straight away
 * before they've written or when the team asked for more; not while the
 * team hasn't answered; a day after the team kept it. Null: not now.
 */
export function appealOpensAt(
  row: { appealState: HostingAppealState; keptAt: Date | null },
  now: Date,
): Date | null {
  switch (row.appealState) {
    case HostingAppealState.NONE:
    case HostingAppealState.WAITING_HOST:
      return now;
    case HostingAppealState.WAITING_STAFF:
      return null;
    case HostingAppealState.KEPT:
      return new Date((row.keptAt ?? now).getTime() + APPEAL_AGAIN_AFTER_MS);
  }
}

/** Where a new appeal picture for [restrictionId] goes - one fresh key per upload. */
export function appealImageKey(restrictionId: string, contentType: AppealImageType): string {
  return `hosting-appeals/${restrictionId}/${randomUUID()}.${APPEAL_IMAGE_TYPES[contentType]}`;
}

/** Only keys handed out for this restriction pass - never another object in the bucket. */
export function isAppealImageKey(key: string, restrictionId: string): boolean {
  const prefix = `hosting-appeals/${restrictionId}/`;
  return (
    key.startsWith(prefix) && new RegExp(`^${UUID}\\.(jpg|png)$`).test(key.slice(prefix.length))
  );
}
