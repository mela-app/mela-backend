import { StreamVisibility } from '@prisma/client';

/** How someone stands with a live's host - null for someone not signed in. */
export interface HostRelation {
  isHost: boolean;
  /** Follows the host. */
  follows: boolean;
  /** Follows the host and is followed back. */
  isFriend: boolean;
}

/**
 * Who may watch a live (docs/features/streams.md): everyone, or the host's
 * followers, or their friends; the host always. The one rule behind
 * discovery, search, joining, the share page, invites and go-live pushes.
 */
export function canWatchLive(visibility: StreamVisibility, relation: HostRelation | null): boolean {
  if (visibility === StreamVisibility.PUBLIC) return true;
  if (!relation) return false;
  if (relation.isHost) return true;
  return visibility === StreamVisibility.FOLLOWERS ? relation.follows : relation.isFriend;
}

/** What the For You ranking knows about one live, for one viewer. */
export interface LiveSignals {
  viewerCount: number;
  likeCount: number;
  startedAt: Date;
  paused: boolean;
  followsHost: boolean;
  friendOfHost: boolean;
  /** How much of what this viewer's people stream is this live's category, 0..1. */
  categoryAffinity: number;
}

// The weights, in one place to tune. Audience and engagement are logarithmic,
// so a live with 1,000 viewers doesn't bury every live with 50, and a new live
// gets a short boost so it can find viewers at all.
export const RANKING_WEIGHTS = {
  audience: 1,
  engagement: 0.6,
  freshness: 1.5,
  freshForMinutes: 15,
  followsHost: 3,
  friendOfHost: 1.5,
  categoryAffinity: 1,
  paused: -2,
} as const;

/**
 * The For You order (higher first): how many watch, how lively it is (likes
 * a minute), how new it is, the viewer's own ties to the host, and how much
 * the people they follow stream in this category. A paused live sinks.
 */
export function liveScore(live: LiveSignals, now: Date): number {
  const w = RANKING_WEIGHTS;
  const minutesLive = Math.max(1, (now.getTime() - live.startedAt.getTime()) / 60_000);
  const audience = Math.log2(1 + Math.max(0, live.viewerCount));
  const engagement = Math.log2(1 + Math.max(0, live.likeCount) / minutesLive);
  const freshness = Math.max(0, 1 - minutesLive / w.freshForMinutes);
  return (
    w.audience * audience +
    w.engagement * engagement +
    w.freshness * freshness +
    (live.followsHost ? w.followsHost : 0) +
    (live.friendOfHost ? w.friendOfHost : 0) +
    w.categoryAffinity * Math.min(1, Math.max(0, live.categoryAffinity)) +
    (live.paused ? w.paused : 0)
  );
}
