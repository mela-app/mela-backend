import { randomUUID } from 'crypto';
import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvents, PresenceChangedPayload } from '../events/domain-events';
import { RedisService } from '../redis/redis.service';

/** A host counts as connected this long after their app's last heartbeat (sent every ~15 s). */
export const HOST_HEARTBEAT_TTL_SECONDS = 90;

/** How long a host who paused their live may leave the app before it's ended. */
export const PAUSED_HOST_TTL_SECONDS = 600;

/** How long a live's "X joined" notice for one person holds off after the last one. */
export const ARRIVAL_NOTICE_TTL_SECONDS = 600;

/** Ids of the share page's viewers without an account: counted as viewers, never listed. */
export const ANONYMOUS_VIEWER_PREFIX = 'web-';

/**
 * How long a live is kept after the host's app went quiet while their video
 * still reaches the media server (LiveKit webhooks): on a weak network the
 * realtime connection can drop while the video keeps flowing.
 */
export const HOST_MEDIA_GRACE_MS = 10 * 60 * 1000;

export const isAnonymousViewer = (viewerId: string): boolean =>
  viewerId.startsWith(ANONYMOUS_VIEWER_PREFIX);

/**
 * An API instance's viewers count this long after its last heartbeat: a
 * crashed instance's sockets are gone, so another instance removes them then.
 */
export const INSTANCE_TTL_SECONDS = 30;
const INSTANCE_HEARTBEAT_MS = 10_000;
// Frees the lock if the instance reaping dies mid-way.
const REAP_LOCK_TTL_MS = 20_000;

// A paused host gets the longer window, so pausing to step away doesn't end the live.
// Also stamps when the host was last heard from (KEYS[3]), which the media
// grace below measures from.
const TOUCH_HOST = `
local ttl = ARGV[1]
if redis.call('EXISTS', KEYS[2]) == 1 then ttl = ARGV[2] end
redis.call('SET', KEYS[1], '1', 'EX', ttl)
redis.call('SET', KEYS[3], ARGV[3])`;

// Keyed by socket, so a repeated join or leave from one socket is harmless;
// counted by user, so one person on two devices is one viewer. Answers the
// viewer count, and 1 when this is the person's first connection in the live.
// Also notes the socket under the API instance holding it (KEYS[4]), so a
// crashed instance's viewers can be found and removed.
const ADD_VIEWER = `
local arrived = 0
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then
  redis.call('HSET', KEYS[4], ARGV[1], ARGV[3])
  if redis.call('HINCRBY', KEYS[2], ARGV[2], 1) == 1 then arrived = 1 end
end
local count = redis.call('HLEN', KEYS[2])
if count > tonumber(redis.call('GET', KEYS[3]) or '0') then
  redis.call('SET', KEYS[3], count)
end
return {count, arrived}`;

const REMOVE_VIEWER = `
redis.call('HDEL', KEYS[3], ARGV[1])
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
export class LivePresenceService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(LivePresenceService.name);
  /** This API instance - each one notes the sockets it holds (see INSTANCE_TTL_SECONDS). */
  readonly instanceId = randomUUID();
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
  ) {}

  // Sockets don't survive their instance, so neither do the viewers they
  // counted; reconnecting apps join again (on any instance). The first
  // instance up wipes every list - nobody else holds a socket, and this also
  // clears lists from before instances were tracked; one joining others only
  // removes what dead instances left.
  async onApplicationBootstrap(): Promise<void> {
    await this.redis.runExclusive('presence-reap', REAP_LOCK_TTL_MS, async () => {
      if ((await this.liveInstances()).length === 0) await this.wipeAll();
      else await this.reapDeadInstances();
      await this.beat();
    });
    // Registered even when another instance held the lock just then.
    await this.beat();
    this.heartbeat = setInterval(() => void this.tick(), INSTANCE_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  // A deploy's SIGTERM: this instance's sockets close with it, so their
  // viewers go now rather than when its heartbeat runs out.
  async beforeApplicationShutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      this.announce(await this.reapInstance(this.instanceId));
    } catch (error) {
      this.logger.warn(`Could not remove this instance's viewers: ${error}`);
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.beat();
      await this.redis.runExclusive('presence-reap', REAP_LOCK_TTL_MS, () =>
        this.reapDeadInstances(),
      );
    } catch (error) {
      this.logger.warn(`Presence upkeep failed: ${error}`);
    }
  }

  private async beat(): Promise<void> {
    await this.redis
      .getClient()
      .multi()
      .set(instanceAliveKey(this.instanceId), '1', 'EX', INSTANCE_TTL_SECONDS)
      .sadd(INSTANCES_KEY, this.instanceId)
      .exec();
  }

  // Registered instances whose heartbeat is still on.
  private async liveInstances(): Promise<string[]> {
    const client = this.redis.getClient();
    const ids = await client.smembers(INSTANCES_KEY);
    if (ids.length === 0) return [];
    const pipeline = client.pipeline();
    for (const id of ids) pipeline.exists(instanceAliveKey(id));
    const results = (await pipeline.exec()) ?? [];
    return ids.filter((_, i) => Number(results[i]?.[1]) === 1);
  }

  /** Removes the viewers of every instance whose heartbeat stopped (a crash, a killed container). */
  async reapDeadInstances(): Promise<void> {
    const ids = await this.redis.getClient().smembers(INSTANCES_KEY);
    const live = new Set(await this.liveInstances());
    const changed = new Set<string>();
    for (const id of ids) {
      if (live.has(id) || id === this.instanceId) continue;
      for (const streamId of await this.reapInstance(id)) changed.add(streamId);
    }
    this.announce([...changed]);
  }

  // Answers the lives whose viewers changed.
  private async reapInstance(id: string): Promise<string[]> {
    const client = this.redis.getClient();
    const sockets = await client.hgetall(instanceSocketsKey(id));
    const streamIds = new Set<string>();
    for (const [socketId, streamId] of Object.entries(sockets)) {
      await client.eval(
        REMOVE_VIEWER,
        3,
        socketsKey(streamId),
        viewersKey(streamId),
        instanceSocketsKey(id),
        socketId,
      );
      streamIds.add(streamId);
    }
    await client
      .multi()
      .del(instanceSocketsKey(id), instanceAliveKey(id))
      .srem(INSTANCES_KEY, id)
      .exec();
    return [...streamIds];
  }

  private async wipeAll(): Promise<void> {
    const client = this.redis.getClient();
    for (const pattern of ['stream:*:viewer_sockets', 'stream:*:viewers', 'realtime:instance:*']) {
      for await (const keys of client.scanStream({ match: pattern, count: 100 })) {
        if ((keys as string[]).length > 0) await client.del(...(keys as string[]));
      }
    }
    await client.del(INSTANCES_KEY);
  }

  // The gateway re-announces those lives' viewer counts.
  private announce(streamIds: string[]): void {
    if (streamIds.length === 0) return;
    this.events.emit(DomainEvents.PresenceChanged, { streamIds } satisfies PresenceChangedPayload);
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
        4,
        socketsKey(streamId),
        viewersKey(streamId),
        peakKey(streamId),
        instanceSocketsKey(this.instanceId),
        socketId,
        userId,
        streamId,
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
      .eval(
        REMOVE_VIEWER,
        3,
        socketsKey(streamId),
        viewersKey(streamId),
        instanceSocketsKey(this.instanceId),
        socketId,
      );
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
        3,
        hostAliveKey(streamId),
        pausedKey(streamId),
        hostSeenKey(streamId),
        HOST_HEARTBEAT_TTL_SECONDS,
        PAUSED_HOST_TTL_SECONDS,
        Date.now(),
      );
  }

  /** The host's video is in the media room (LiveKit webhooks), or left it. */
  async setHostMedia(streamId: string, present: boolean): Promise<void> {
    const client = this.redis.getClient();
    if (present) await client.set(hostMediaKey(streamId), '1');
    else await client.del(hostMediaKey(streamId));
  }

  /**
   * Lives whose host is still there: their app's heartbeat is on, or - for
   * up to {@link HOST_MEDIA_GRACE_MS} after it was last heard - their video
   * still reaches the media server. The sweeper ends the others.
   */
  async presentHosts(streamIds: string[], now = Date.now()): Promise<Set<string>> {
    if (streamIds.length === 0) return new Set();
    const pipeline = this.redis.getClient().pipeline();
    for (const id of streamIds) {
      pipeline.exists(hostAliveKey(id));
      pipeline.exists(hostMediaKey(id));
      pipeline.get(hostSeenKey(id));
    }
    const results = (await pipeline.exec()) ?? [];
    return new Set(
      streamIds.filter((_, i) => {
        const [alive, media, seen] = [0, 1, 2].map((offset) => results[i * 3 + offset]?.[1]);
        if (Number(alive) === 1) return true;
        return Number(media) === 1 && seen != null && now - Number(seen) < HOST_MEDIA_GRACE_MS;
      }),
    );
  }

  /** A guest's video left the media room - removed from the stage if it doesn't come back (sweeper). */
  async noteGuestGone(streamId: string, userId: string, now = Date.now()): Promise<void> {
    await this.redis.getClient().zadd(GUESTS_GONE_KEY, now, guestGoneMember(streamId, userId));
  }

  async clearGuestGone(streamId: string, userId: string): Promise<void> {
    await this.redis.getClient().zrem(GUESTS_GONE_KEY, guestGoneMember(streamId, userId));
  }

  /** Guests gone since before [cutoff], each handed to exactly one caller. */
  async takeGuestsGoneBefore(cutoff: number): Promise<Array<{ streamId: string; userId: string }>> {
    const client = this.redis.getClient();
    const members = await client.zrangebyscore(GUESTS_GONE_KEY, 0, cutoff);
    const taken: Array<{ streamId: string; userId: string }> = [];
    for (const member of members) {
      // Only the instance whose ZREM removed it acts on it.
      if ((await client.zrem(GUESTS_GONE_KEY, member)) !== 1) continue;
      const [streamId, userId] = member.split('|');
      if (streamId && userId) taken.push({ streamId, userId });
    }
    return taken;
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

  /** Many lives' running like totals in one round trip (For You ranking). */
  async likeCounts(streamIds: string[]): Promise<Map<string, number>> {
    if (streamIds.length === 0) return new Map();
    const pipeline = this.redis.getClient().pipeline();
    for (const id of streamIds) pipeline.get(likesKey(id));
    const results = (await pipeline.exec()) ?? [];
    return new Map(streamIds.map((id, i) => [id, Number(results[i]?.[1] ?? 0)]));
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
        hostMediaKey(streamId),
        hostSeenKey(streamId),
      );
  }
}

const INSTANCES_KEY = 'realtime:instances';
const instanceAliveKey = (id: string) => `realtime:instance:${id}:alive`;
// Socket id -> the live it watches, for every viewer socket one API instance holds.
const instanceSocketsKey = (id: string) => `realtime:instance:${id}:sockets`;
const socketsKey = (streamId: string) => `stream:${streamId}:viewer_sockets`;
const viewersKey = (streamId: string) => `stream:${streamId}:viewers`;
const peakKey = (streamId: string) => `stream:${streamId}:peak_viewers`;
const hostAliveKey = (streamId: string) => `stream:${streamId}:host_alive`;
const hostAwayKey = (streamId: string) => `stream:${streamId}:host_away`;
const pausedKey = (streamId: string) => `stream:${streamId}:paused`;
const likesKey = (streamId: string) => `stream:${streamId}:likes`;
const hostMediaKey = (streamId: string) => `stream:${streamId}:host_media`;
const hostSeenKey = (streamId: string) => `stream:${streamId}:host_seen`;
// Scored by when each guest's video left: `${streamId}|${userId}`.
const GUESTS_GONE_KEY = 'stream:guests_gone';
const guestGoneMember = (streamId: string, userId: string) => `${streamId}|${userId}`;
const arrivalNoticeKey = (streamId: string, userId: string) =>
  `stream:${streamId}:arrival_notice:${userId}`;
