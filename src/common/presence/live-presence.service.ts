import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/** A host counts as connected this long after their app's last heartbeat (sent every ~15 s). */
export const HOST_HEARTBEAT_TTL_SECONDS = 90;

/** How long a host who paused their live may leave the app before it's ended. */
export const PAUSED_HOST_TTL_SECONDS = 600;

/** How long a live's "X joined" notice for one person holds off after the last one. */
export const ARRIVAL_NOTICE_TTL_SECONDS = 600;

/** Ids of the share page's viewers without an account: counted as viewers, never listed. */
export const ANONYMOUS_VIEWER_PREFIX = 'web-';

export const isAnonymousViewer = (viewerId: string): boolean => viewerId.startsWith(ANONYMOUS_VIEWER_PREFIX);

// A paused host gets the longer window, so pausing to step away doesn't end the live.
const TOUCH_HOST = `
local ttl = ARGV[1]
if redis.call('EXISTS', KEYS[2]) == 1 then ttl = ARGV[2] end
redis.call('SET', KEYS[1], '1', 'EX', ttl)`;

// Keyed by socket, so a repeated join or leave from one socket is harmless;
// counted by user, so one person on two devices is one viewer. Answers the
// viewer count, and 1 when this is the person's first connection in the live.
const ADD_VIEWER = `
local arrived = 0
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then
  if redis.call('HINCRBY', KEYS[2], ARGV[2], 1) == 1 then arrived = 1 end
end
local count = redis.call('HLEN', KEYS[2])
if count > tonumber(redis.call('GET', KEYS[3]) or '0') then
  redis.call('SET', KEYS[3], count)
end
return {count, arrived}`;

const REMOVE_VIEWER = `
local userId = redis.call('HGET', KEYS[1], ARGV[1])
if userId then
  redis.call('HDEL', KEYS[1], ARGV[1])
  if redis.call('HINCRBY', KEYS[2], userId, -1) <= 0 then
    redis.call('HDEL', KEYS[2], userId)
  end
end
return redis.call('HLEN', KEYS[2])`;

/**
 * Who is in each live right now, held in Redis: unique viewers (and the
 * peak), the host's heartbeat and "away" and "paused" flags, and the running
 * like total. Shared by the realtime gateway (which updates it) and
 * StreamsService (which ranks, sweeps and ends lives with it). See
 * docs/features/realtime.md.
 */
@Injectable()
export class LivePresenceService implements OnApplicationBootstrap {
  constructor(private readonly redis: RedisService) {}

  // Sockets don't survive a restart, so neither do the viewer lists they
  // built; reconnecting apps join again. Assumes one API instance.
  async onApplicationBootstrap(): Promise<void> {
    const client = this.redis.getClient();
    for (const pattern of ['stream:*:viewer_sockets', 'stream:*:viewers']) {
      for await (const keys of client.scanStream({ match: pattern, count: 100 })) {
        if ((keys as string[]).length > 0) await client.del(...(keys as string[]));
      }
    }
  }

  /** [arrived]: the person had no other connection in this live - they just came in. */
  async addViewer(
    streamId: string,
    userId: string,
    socketId: string,
  ): Promise<{ viewerCount: number; arrived: boolean }> {
    const [count, arrived] = (await this.redis
      .getClient()
      .eval(
        ADD_VIEWER,
        3,
        socketsKey(streamId),
        viewersKey(streamId),
        peakKey(streamId),
        socketId,
        userId,
      )) as [number, number];
    return { viewerCount: Number(count), arrived: Number(arrived) === 1 };
  }

  /**
   * Whether this arrival gets an "X joined" notice: once per person per
   * {@link ARRIVAL_NOTICE_TTL_SECONDS}, so a flaky connection rejoining - or
   * someone swiping back and forth between lives - isn't announced each time.
   */
  async claimArrivalNotice(streamId: string, userId: string): Promise<boolean> {
    const set = await this.redis
      .getClient()
      .set(arrivalNoticeKey(streamId, userId), '1', 'EX', ARRIVAL_NOTICE_TTL_SECONDS, 'NX');
    return set === 'OK';
  }

  async removeViewer(streamId: string, socketId: string): Promise<number> {
    const count = await this.redis
      .getClient()
      .eval(REMOVE_VIEWER, 2, socketsKey(streamId), viewersKey(streamId), socketId);
    return Number(count);
  }

  async viewerCount(streamId: string): Promise<number> {
    return this.redis.getClient().hlen(viewersKey(streamId));
  }

  /** Every unique viewer's user id, unordered - for the viewer-list sheet (plan §6.13). */
  /** The accounts watching - the browser's anonymous viewers count, but aren't anyone to list. */
  async viewerIds(streamId: string): Promise<string[]> {
    const ids = await this.redis.getClient().hkeys(viewersKey(streamId));
    return ids.filter((id) => !isAnonymousViewer(id));
  }

  async viewerCounts(streamIds: string[]): Promise<Map<string, number>> {
    if (streamIds.length === 0) return new Map();
    const pipeline = this.redis.getClient().pipeline();
    for (const id of streamIds) pipeline.hlen(viewersKey(id));
    const results = (await pipeline.exec()) ?? [];
    return new Map(streamIds.map((id, i) => [id, Number(results[i]?.[1] ?? 0)]));
  }

  async peakViewerCount(streamId: string): Promise<number> {
    return Number((await this.redis.getClient().get(peakKey(streamId))) ?? 0);
  }

  async touchHost(streamId: string): Promise<void> {
    await this.redis
      .getClient()
      .eval(
        TOUCH_HOST,
        2,
        hostAliveKey(streamId),
        pausedKey(streamId),
        HOST_HEARTBEAT_TTL_SECONDS,
        PAUSED_HOST_TTL_SECONDS,
      );
  }

  async connectedHosts(streamIds: string[]): Promise<Set<string>> {
    if (streamIds.length === 0) return new Set();
    const pipeline = this.redis.getClient().pipeline();
    for (const id of streamIds) pipeline.exists(hostAliveKey(id));
    const results = (await pipeline.exec()) ?? [];
    return new Set(streamIds.filter((_, i) => Number(results[i]?.[1]) === 1));
  }

  /** Returns whether the flag actually changed, so callers only announce real transitions. */
  async setHostAway(streamId: string, away: boolean): Promise<boolean> {
    const client = this.redis.getClient();
    const changed = away
      ? await client.set(hostAwayKey(streamId), '1', 'NX')
      : await client.del(hostAwayKey(streamId));
    return away ? changed === 'OK' : changed === 1;
  }

  async isHostAway(streamId: string): Promise<boolean> {
    return (await this.redis.getClient().exists(hostAwayKey(streamId))) === 1;
  }

  /** Returns whether the flag actually changed, like {@link setHostAway}. */
  async setPaused(streamId: string, paused: boolean): Promise<boolean> {
    const client = this.redis.getClient();
    return paused
      ? (await client.set(pausedKey(streamId), '1', 'NX')) === 'OK'
      : (await client.del(pausedKey(streamId))) === 1;
  }

  async isPaused(streamId: string): Promise<boolean> {
    return (await this.redis.getClient().exists(pausedKey(streamId))) === 1;
  }

  async pausedLives(streamIds: string[]): Promise<Set<string>> {
    if (streamIds.length === 0) return new Set();
    const pipeline = this.redis.getClient().pipeline();
    for (const id of streamIds) pipeline.exists(pausedKey(id));
    const results = (await pipeline.exec()) ?? [];
    return new Set(streamIds.filter((_, i) => Number(results[i]?.[1]) === 1));
  }

  /** Returns the new total. */
  async addLikes(streamId: string, count: number): Promise<number> {
    return this.redis.getClient().incrby(likesKey(streamId), count);
  }

  async likeCount(streamId: string): Promise<number> {
    return Number((await this.redis.getClient().get(likesKey(streamId))) ?? 0);
  }

  async clear(streamId: string): Promise<void> {
    await this.redis
      .getClient()
      .del(
        socketsKey(streamId),
        viewersKey(streamId),
        peakKey(streamId),
        hostAliveKey(streamId),
        hostAwayKey(streamId),
        pausedKey(streamId),
        likesKey(streamId),
      );
  }
}

const socketsKey = (streamId: string) => `stream:${streamId}:viewer_sockets`;
const viewersKey = (streamId: string) => `stream:${streamId}:viewers`;
const peakKey = (streamId: string) => `stream:${streamId}:peak_viewers`;
const hostAliveKey = (streamId: string) => `stream:${streamId}:host_alive`;
const hostAwayKey = (streamId: string) => `stream:${streamId}:host_away`;
const pausedKey = (streamId: string) => `stream:${streamId}:paused`;
const likesKey = (streamId: string) => `stream:${streamId}:likes`;
const arrivalNoticeKey = (streamId: string, userId: string) => `stream:${streamId}:arrival_notice:${userId}`;
