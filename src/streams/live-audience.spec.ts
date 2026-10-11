import { StreamVisibility } from '@prisma/client';
import { canWatchLive, LiveSignals, liveScore } from './live-audience';

describe('canWatchLive', () => {
  const stranger = { isHost: false, follows: false, isFriend: false };
  const follower = { isHost: false, follows: true, isFriend: false };
  const friend = { isHost: false, follows: true, isFriend: true };
  const host = { isHost: true, follows: false, isFriend: false };

  it('a public live is for everyone, signed in or not', () => {
    for (const relation of [null, stranger, follower, friend, host]) {
      expect(canWatchLive(StreamVisibility.PUBLIC, relation)).toBe(true);
    }
  });

  it("a followers' live is for followers (friends follow too) and the host", () => {
    expect(canWatchLive(StreamVisibility.FOLLOWERS, null)).toBe(false);
    expect(canWatchLive(StreamVisibility.FOLLOWERS, stranger)).toBe(false);
    expect(canWatchLive(StreamVisibility.FOLLOWERS, follower)).toBe(true);
    expect(canWatchLive(StreamVisibility.FOLLOWERS, friend)).toBe(true);
    expect(canWatchLive(StreamVisibility.FOLLOWERS, host)).toBe(true);
  });

  it("a friends' live is for friends and the host only", () => {
    expect(canWatchLive(StreamVisibility.FRIENDS, null)).toBe(false);
    expect(canWatchLive(StreamVisibility.FRIENDS, stranger)).toBe(false);
    expect(canWatchLive(StreamVisibility.FRIENDS, follower)).toBe(false);
    expect(canWatchLive(StreamVisibility.FRIENDS, friend)).toBe(true);
    expect(canWatchLive(StreamVisibility.FRIENDS, host)).toBe(true);
  });
});

describe('liveScore', () => {
  const now = new Date('2026-10-10T20:00:00Z');
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const live = (overrides: Partial<LiveSignals> = {}): LiveSignals => ({
    viewerCount: 10,
    likeCount: 0,
    startedAt: minutesAgo(60),
    paused: false,
    followsHost: false,
    friendOfHost: false,
    categoryAffinity: 0,
    ...overrides,
  });

  it('more viewers rank higher, but not overwhelmingly', () => {
    const big = liveScore(live({ viewerCount: 1000 }), now);
    const small = liveScore(live({ viewerCount: 50 }), now);
    expect(big).toBeGreaterThan(small);
    // A friend's live with 50 viewers still beats a stranger's with 1,000.
    expect(
      liveScore(live({ viewerCount: 50, followsHost: true, friendOfHost: true }), now),
    ).toBeGreaterThan(big);
  });

  it('a lively live (likes a minute) beats a quiet one of the same size', () => {
    expect(liveScore(live({ likeCount: 600 }), now)).toBeGreaterThan(liveScore(live(), now));
  });

  it('a just-started live gets a short boost so it can find viewers', () => {
    const fresh = liveScore(live({ viewerCount: 2, startedAt: minutesAgo(1) }), now);
    const stale = liveScore(live({ viewerCount: 2, startedAt: minutesAgo(30) }), now);
    expect(fresh).toBeGreaterThan(stale);
    expect(liveScore(live({ startedAt: minutesAgo(15) }), now)).toBeCloseTo(
      liveScore(live({ startedAt: minutesAgo(90) }), now),
      5,
    );
  });

  it("the viewer's own ties and interests lift a live; a paused one sinks", () => {
    const base = liveScore(live(), now);
    expect(liveScore(live({ followsHost: true }), now)).toBeGreaterThan(base);
    expect(liveScore(live({ categoryAffinity: 0.8 }), now)).toBeGreaterThan(base);
    expect(liveScore(live({ paused: true }), now)).toBeLessThan(base);
  });

  it('copes with odd input', () => {
    expect(
      Number.isFinite(liveScore(live({ viewerCount: -3, startedAt: minutesAgo(-5) }), now)),
    ).toBe(true);
  });
});
