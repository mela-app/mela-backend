import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvents } from '../events/domain-events';
import { RedisService } from '../redis/redis.service';
import {
  ARRIVAL_NOTICE_TTL_SECONDS,
  HOST_HEARTBEAT_TTL_SECONDS,
  HOST_MEDIA_GRACE_MS,
  LivePresenceService,
  PAUSED_HOST_TTL_SECONDS,
} from './live-presence.service';

describe('LivePresenceService', () => {
  const pipeline = { hlen: jest.fn(), exists: jest.fn(), exec: jest.fn() };
  const client = {
    eval: jest.fn(),
    hlen: jest.fn(),
    hkeys: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    incrby: jest.fn(),
    pipeline: jest.fn(() => pipeline),
  };
  const multi = {
    set: jest.fn(),
    sadd: jest.fn(),
    del: jest.fn(),
    srem: jest.fn(),
    exec: jest.fn(),
  };
  for (const step of ['set', 'sadd', 'del', 'srem'] as const) multi[step].mockReturnValue(multi);
  Object.assign(client, {
    smembers: jest.fn(),
    hgetall: jest.fn(),
    multi: jest.fn(() => multi),
    scanStream: jest.fn(),
  });
  const extra = client as unknown as {
    smembers: jest.Mock;
    hgetall: jest.Mock;
    scanStream: jest.Mock;
  };
  // Runs the task as if this instance got the lock.
  const runExclusive = jest.fn(async (_name: string, _ttl: number, task: () => Promise<void>) => {
    await task();
    return true;
  });
  const redis = { getClient: () => client, runExclusive } as unknown as RedisService;
  const events = { emit: jest.fn() };
  const service = () => new LivePresenceService(redis, events as unknown as EventEmitter2);

  beforeEach(() => jest.clearAllMocks());

  it('adds a viewer by socket, counted by user, and returns the unique count', async () => {
    client.eval.mockResolvedValue([3, 0]);
    const presence = service();

    await expect(presence.addViewer('s1', 'user-1', 'socket-1')).resolves.toEqual({
      viewerCount: 3,
      arrived: false,
    });

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('HSETNX'),
      4,
      'stream:s1:viewer_sockets',
      'stream:s1:viewers',
      'stream:s1:peak_viewers',
      `realtime:instance:${presence.instanceId}:sockets`,
      'socket-1',
      'user-1',
      's1',
    );
  });

  it("says when it's the person's first connection in the live", async () => {
    client.eval.mockResolvedValue([4, 1]);

    await expect(service().addViewer('s1', 'user-2', 'socket-2')).resolves.toEqual({
      viewerCount: 4,
      arrived: true,
    });
  });

  it('lists only the accounts watching - browser viewers without one are counted, not listed', async () => {
    client.hkeys.mockResolvedValueOnce([
      'user-1',
      'web-9b2f0c1d-4e5a-4a8b-9d7e-2b6f0c1d4e5a',
      'user-2',
    ]);

    await expect(service().viewerIds('s1')).resolves.toEqual(['user-1', 'user-2']);
    expect(client.hkeys).toHaveBeenCalledWith('stream:s1:viewers');
  });

  it('claims an arrival notice once per person until it expires', async () => {
    client.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    await expect(service().claimArrivalNotice('s1', 'user-1')).resolves.toBe(true);
    await expect(service().claimArrivalNotice('s1', 'user-1')).resolves.toBe(false);
    expect(client.set).toHaveBeenCalledWith(
      'stream:s1:arrival_notice:user-1',
      '1',
      'EX',
      ARRIVAL_NOTICE_TTL_SECONDS,
      'NX',
    );
  });

  it('removes a viewer by socket', async () => {
    client.eval.mockResolvedValue(2);

    const presence = service();
    await expect(presence.removeViewer('s1', 'socket-1')).resolves.toBe(2);

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('HGET'),
      3,
      'stream:s1:viewer_sockets',
      'stream:s1:viewers',
      `realtime:instance:${presence.instanceId}:sockets`,
      'socket-1',
    );
  });

  describe('several API instances', () => {
    it("removes a dead instance's viewers, and only theirs, and re-announces those lives", async () => {
      extra.smembers.mockResolvedValue(['alive-1', 'dead-1']);
      pipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 0],
      ]);
      extra.hgetall.mockResolvedValue({ 'socket-a': 's1', 'socket-b': 's2', 'socket-c': 's1' });

      await service().reapDeadInstances();

      expect(extra.hgetall).toHaveBeenCalledTimes(1);
      expect(extra.hgetall).toHaveBeenCalledWith('realtime:instance:dead-1:sockets');
      expect(client.eval).toHaveBeenCalledTimes(3);
      expect(client.eval).toHaveBeenCalledWith(
        expect.stringContaining('HGET'),
        3,
        'stream:s2:viewer_sockets',
        'stream:s2:viewers',
        'realtime:instance:dead-1:sockets',
        'socket-b',
      );
      expect(multi.srem).toHaveBeenCalledWith('realtime:instances', 'dead-1');
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.PresenceChanged, {
        streamIds: ['s1', 's2'],
      });
    });

    it('leaves everything alone while every instance is alive', async () => {
      extra.smembers.mockResolvedValue(['alive-1']);
      pipeline.exec.mockResolvedValue([[null, 1]]);

      await service().reapDeadInstances();

      expect(extra.hgetall).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it("a restart while other instances run keeps their viewers, removing the dead ones'", async () => {
      extra.smembers.mockResolvedValue(['alive-1', 'dead-1']);
      pipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 0],
      ]);
      extra.hgetall.mockResolvedValue({});
      const presence = service();

      await presence.onApplicationBootstrap();
      await presence.beforeApplicationShutdown();

      expect(extra.scanStream).not.toHaveBeenCalled();
      expect(extra.hgetall).toHaveBeenCalledWith('realtime:instance:dead-1:sockets');
      expect(multi.set).toHaveBeenCalledWith(
        `realtime:instance:${presence.instanceId}:alive`,
        '1',
        'EX',
        30,
      );
      expect(multi.sadd).toHaveBeenCalledWith('realtime:instances', presence.instanceId);
    });

    it('the first instance up starts every viewer list afresh', async () => {
      extra.smembers.mockResolvedValue([]);
      extra.scanStream.mockImplementation(() =>
        (async function* () {
          yield ['stream:s1:viewers'];
        })(),
      );
      const presence = service();

      await presence.onApplicationBootstrap();
      await presence.beforeApplicationShutdown();

      expect(extra.scanStream).toHaveBeenCalledTimes(3);
      expect(client.del).toHaveBeenCalledWith('stream:s1:viewers');
      expect(client.del).toHaveBeenCalledWith('realtime:instances');
    });

    it('a shutting-down instance removes its own viewers at once', async () => {
      extra.hgetall.mockResolvedValue({ 'socket-a': 's1' });
      const presence = service();

      await presence.beforeApplicationShutdown();

      expect(extra.hgetall).toHaveBeenCalledWith(
        `realtime:instance:${presence.instanceId}:sockets`,
      );
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.PresenceChanged, { streamIds: ['s1'] });
    });
  });

  it("reads many lives' viewer counts in one round trip", async () => {
    pipeline.exec.mockResolvedValue([
      [null, 4],
      [null, 0],
    ]);

    const counts = await service().viewerCounts(['a', 'b']);

    expect(pipeline.hlen).toHaveBeenCalledWith('stream:a:viewers');
    expect(pipeline.hlen).toHaveBeenCalledWith('stream:b:viewers');
    expect([...counts]).toEqual([
      ['a', 4],
      ['b', 0],
    ]);
  });

  it('skips Redis entirely for an empty list', async () => {
    await expect(service().viewerCounts([])).resolves.toEqual(new Map());
    await expect(service().connectedHosts([])).resolves.toEqual(new Set());
    await expect(service().pausedLives([])).resolves.toEqual(new Set());
    expect(client.pipeline).not.toHaveBeenCalled();
  });

  it('keeps a heartbeat for the grace window, a longer one while the live is paused', async () => {
    await service().touchHost('s1');

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('EXISTS'),
      3,
      'stream:s1:host_alive',
      'stream:s1:paused',
      'stream:s1:host_seen',
      HOST_HEARTBEAT_TTL_SECONDS,
      PAUSED_HOST_TTL_SECONDS,
      expect.any(Number),
    );
    expect(PAUSED_HOST_TTL_SECONDS).toBeGreaterThan(HOST_HEARTBEAT_TTL_SECONDS);
  });

  describe("the host's video in the media room (LiveKit webhooks)", () => {
    const now = 1_760_000_000_000;
    // [alive, media, seen] per live, as the pipeline answers them.
    const answer = (...lives: Array<[number, number, string | null]>) =>
      pipeline.exec.mockResolvedValue(lives.flat().map((value) => [null, value]));
    Object.assign(pipeline, { get: jest.fn() });

    it('a heartbeat alone keeps the host there', async () => {
      answer([1, 0, null]);
      await expect(service().presentHosts(['s1'], now)).resolves.toEqual(new Set(['s1']));
    });

    it("without one, the host's video keeps them there for the grace window after they were last heard", async () => {
      answer(
        [0, 1, String(now - HOST_MEDIA_GRACE_MS + 1000)],
        [0, 1, String(now - HOST_MEDIA_GRACE_MS - 1000)],
        [0, 0, String(now - 1000)],
        [0, 1, null],
      );

      await expect(
        service().presentHosts(['fresh', 'stale', 'no-video', 'never'], now),
      ).resolves.toEqual(new Set(['fresh']));
    });

    it('notes and forgets the video', async () => {
      const presence = service();
      await presence.setHostMedia('s1', true);
      await presence.setHostMedia('s1', false);

      expect(client.set).toHaveBeenCalledWith('stream:s1:host_media', '1');
      expect(client.del).toHaveBeenCalledWith('stream:s1:host_media');
    });
  });

  describe('guests whose video dropped', () => {
    Object.assign(client, { zadd: jest.fn(), zrem: jest.fn(), zrangebyscore: jest.fn() });
    const z = client as unknown as { zadd: jest.Mock; zrem: jest.Mock; zrangebyscore: jest.Mock };

    it('notes when, and forgets it when they come back', async () => {
      await service().noteGuestGone('s1', 'guest-1', 1000);
      await service().clearGuestGone('s1', 'guest-1');

      expect(z.zadd).toHaveBeenCalledWith('stream:guests_gone', 1000, 's1|guest-1');
      expect(z.zrem).toHaveBeenCalledWith('stream:guests_gone', 's1|guest-1');
    });

    it('hands each one gone long enough to exactly one instance', async () => {
      z.zrangebyscore.mockResolvedValue(['s1|guest-1', 's2|guest-2']);
      // Another instance took the second one first.
      z.zrem.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

      await expect(service().takeGuestsGoneBefore(5000)).resolves.toEqual([
        { streamId: 's1', userId: 'guest-1' },
      ]);
      expect(z.zrangebyscore).toHaveBeenCalledWith('stream:guests_gone', 0, 5000);
    });
  });

  it('reports which hosts still have a heartbeat', async () => {
    pipeline.exec.mockResolvedValue([
      [null, 1],
      [null, 0],
    ]);

    await expect(service().connectedHosts(['alive', 'gone'])).resolves.toEqual(new Set(['alive']));
  });

  it('reports whether the away flag actually changed', async () => {
    client.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    client.del.mockResolvedValueOnce(1);

    await expect(service().setHostAway('s1', true)).resolves.toBe(true);
    await expect(service().setHostAway('s1', true)).resolves.toBe(false);
    await expect(service().setHostAway('s1', false)).resolves.toBe(true);
    expect(client.set).toHaveBeenCalledWith('stream:s1:host_away', '1', 'NX');
  });

  it('reports whether the paused flag actually changed', async () => {
    client.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    client.del.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(service().setPaused('s1', true)).resolves.toBe(true);
    await expect(service().setPaused('s1', true)).resolves.toBe(false);
    await expect(service().setPaused('s1', false)).resolves.toBe(true);
    await expect(service().setPaused('s1', false)).resolves.toBe(false);
    expect(client.set).toHaveBeenCalledWith('stream:s1:paused', '1', 'NX');
  });

  it('reports which lives are paused', async () => {
    pipeline.exec.mockResolvedValue([
      [null, 0],
      [null, 1],
    ]);

    await expect(service().pausedLives(['on', 'paused'])).resolves.toEqual(new Set(['paused']));
    expect(pipeline.exists).toHaveBeenCalledWith('stream:paused:paused');
  });

  it("keeps a live's running like total", async () => {
    client.incrby.mockResolvedValueOnce(42);
    client.get.mockResolvedValueOnce('42').mockResolvedValueOnce(null);

    await expect(service().addLikes('s1', 5)).resolves.toBe(42);
    await expect(service().likeCount('s1')).resolves.toBe(42);
    await expect(service().likeCount('none')).resolves.toBe(0);
    expect(client.incrby).toHaveBeenCalledWith('stream:s1:likes', 5);
  });

  it('forgets everything about a live that ended', async () => {
    await service().clear('s1');

    expect(client.del).toHaveBeenCalledWith(
      'stream:s1:viewer_sockets',
      'stream:s1:viewers',
      'stream:s1:peak_viewers',
      'stream:s1:host_alive',
      'stream:s1:host_away',
      'stream:s1:paused',
      'stream:s1:likes',
      'stream:s1:host_media',
      'stream:s1:host_seen',
    );
  });
});
