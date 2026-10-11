import { Prisma } from '@prisma/client';

/** The earliest a live can be scheduled for: a few minutes ahead, so the reminder has time to go out. */
export const MIN_LEAD_MS = 5 * 60 * 1000;
/** How far ahead a live can be scheduled. */
export const MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** A host can have this many scheduled lives coming up at once. */
export const MAX_UPCOMING_PER_HOST = 10;
/** Reminders go out this long before the start. */
export const REMIND_BEFORE_MS = 10 * 60 * 1000;
/**
 * A scheduled live stays on show this long past its time - the host may be a
 * little late - and they can go live from it until then.
 */
export const LATE_GRACE_MS = 60 * 60 * 1000;
/** The host can go live from it this early. */
export const EARLY_START_MS = 60 * 60 * 1000;

/** Not cancelled, not started from yet, and not long past its time. */
export function upcomingWhere(now: Date): Prisma.ScheduledLiveWhereInput {
  return {
    cancelledAt: null,
    streamId: null,
    startsAt: { gte: new Date(now.getTime() - LATE_GRACE_MS) },
  };
}
