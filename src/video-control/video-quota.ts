/** Agora's free minutes a month (its pricing, 2026). */
export const DEFAULT_AGORA_FREE_MINUTES = 10_000;

/** Below this many free minutes left, the automatic switch moves new lives to LiveKit. */
export const DEFAULT_AUTO_SWITCH_BELOW = 500;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Agora's free minutes restart every calendar month: its first day, UTC midnight. */
export function periodStartOf(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** When the period holding [now] ends - and the free minutes restart. */
export function nextPeriodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** UTC midnight of [now]'s day. */
export function dayStartOf(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** YYYY-MM-DD (UTC). */
export function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export interface QuotaView {
  freeMinutes: number;
  usedMinutes: number;
  remainingMinutes: number;
  // 0 to 100.
  percentUsed: number;
  // Minutes used per minute right now (everyone on a live on this provider).
  burnPerMinute: number;
  // When the free minutes run out at the current pace; null: not before the reset, or nothing is using them.
  runsOutAt: Date | null;
}

export function quotaView(
  freeMinutes: number,
  usedMinutes: number,
  burnPerMinute: number,
  now: Date,
  resetsAt: Date,
): QuotaView {
  const used = Math.max(0, usedMinutes);
  const remaining = Math.max(0, freeMinutes - used);
  let runsOutAt: Date | null = null;
  if (burnPerMinute > 0 && remaining > 0) {
    const at = new Date(now.getTime() + (remaining / burnPerMinute) * 60_000);
    if (at.getTime() < resetsAt.getTime()) runsOutAt = at;
  }
  return {
    freeMinutes,
    usedMinutes: used,
    remainingMinutes: remaining,
    percentUsed:
      freeMinutes > 0 ? Math.min(100, Math.round((used / freeMinutes) * 1000) / 10) : 100,
    burnPerMinute,
    runsOutAt,
  };
}

/** A day's usage as stored: Mela's count, and the provider's report if fetched. */
export interface UsageDay {
  day: Date;
  countedMinutes: number;
  reportedMinutes: number | null;
  reportedAt: Date | null;
}

// A report fetched this long after the day ended is taken as final.
const SETTLE_MS = 6 * 60 * 60 * 1000;

export interface PeriodUsage {
  usedMinutes: number;
  // From Agora's report: days it has finished counting.
  reportedMinutes: number;
  // Days Agora hasn't finished yet (today, mostly): Mela's count, or Agora's partial figure if higher.
  pendingMinutes: number;
  // The last day Agora finished; null: none yet.
  reportedThrough: Date | null;
}

/**
 * This period's used minutes: Agora's own figures for every day it has
 * finished reporting, Mela's count only for the days it hasn't.
 */
export function periodUsage(days: UsageDay[]): PeriodUsage {
  let reported = 0;
  let pending = 0;
  let reportedThrough: Date | null = null;
  for (const each of days) {
    const settled =
      each.reportedMinutes !== null &&
      each.reportedAt !== null &&
      each.reportedAt.getTime() >= each.day.getTime() + DAY_MS + SETTLE_MS;
    if (settled) {
      reported += each.reportedMinutes!;
      if (!reportedThrough || each.day > reportedThrough) reportedThrough = each.day;
    } else {
      pending += Math.max(each.countedMinutes, each.reportedMinutes ?? 0);
    }
  }
  return {
    usedMinutes: reported + pending,
    reportedMinutes: reported,
    pendingMinutes: pending,
    reportedThrough,
  };
}
