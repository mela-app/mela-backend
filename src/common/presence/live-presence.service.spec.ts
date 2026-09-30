import { RedisService } from '../redis/redis.service';
import {
  ARRIVAL_NOTICE_TTL_SECONDS,
  HOST_HEARTBEAT_TTL_SECONDS,
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
  const redis = { getClient: () => client } as unknown as RedisService;
  const service = () => new LivePresenceService(redis);

  beforeEach(() => jest.clearAllMocks());

  it('adds a viewer by socket, counted by user, and returns the unique count', async () => {
    client.eval.mockResolvedValue([3, 0]);

    await expect(service().addViewer('s1', 'user-1', 'socket-1')).resolves.toEqual({ viewerCount: 3, arrived: false });

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('HSETNX'),
      3,
      'stream:s1:viewer_sockets',
      'stream:s1:viewers',
      'stream:s1:peak_viewers',
      'socket-1',
      'user-1',
    );
  });

  it("says when it's the person's first connection in the live", async () => {
    client.eval.mockResolvedValue([4, 1]);

    await expect(service().addViewer('s1', 'user-2', 'socket-2')).resolves.toEqual({ viewerCount: 4, arrived: true });
  });

  it('lists only the accounts watching - browser viewers without one are counted, not listed', async () => {
    client.hkeys.mockResolvedValueOnce(['user-1', 'web-9b2f0c1d-4e5a-4a8b-9d7e-2b6f0c1d4e5a', 'user-2']);

    await expect(service().viewerIds('s1')).resolves.toEqual(['user-1', 'user-2']);
    expect(client.hkeys).toHaveBeenCalledWith('stream:s1:viewers');
  });

  it('claims an arrival notice once per person until it expires', async () => {
    client.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    await expect(service().claimArrivalNotice('s1', 'user-1')).resolves.toBe(true);
    await expect(service().claimArrivalNotice('s1', 'user-1')).resolves.toBe(false);
    expect(client.set).toHaveBeenCalledWith('stream:s1:arrival_notice:user-1', '1', 'EX', ARRIVAL_NOTICE_TTL_SECONDS, 'NX');
  });

  it('removes a viewer by socket', async () => {
    client.eval.mockResolvedValue(2);

    await expect(service().removeViewer('s1', 'socket-1')).resolves.toBe(2);

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('HGET'),
      2,
      'stream:s1:viewer_sockets',
      'stream:s1:viewers',
      'socket-1',
    );
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
      2,
      'stream:s1:host_alive',
      'stream:s1:paused',
      HOST_HEARTBEAT_TTL_SECONDS,
      PAUSED_HOST_TTL_SECONDS,
    );
    expect(PAUSED_HOST_TTL_SECONDS).toBeGreaterThan(HOST_HEARTBEAT_TTL_SECONDS);
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
    );
  });
});
