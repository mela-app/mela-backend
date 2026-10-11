/** How often someone may change their own username, and their display name (client request, 2026-10). */
export const USERNAME_CHANGE_DAYS = 30;
export const DISPLAY_NAME_CHANGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a name last changed at [changedAt] may change again; null when it may now. */
export function nextNameChangeAt(
  changedAt: Date | null,
  days: number,
  now: Date = new Date(),
): Date | null {
  if (!changedAt) return null;
  const next = new Date(changedAt.getTime() + days * DAY_MS);
  return next > now ? next : null;
}
