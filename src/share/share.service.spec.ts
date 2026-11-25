import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StreamStatus, StreamVisibility } from '@prisma/client';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { RedisService } from '../common/redis/redis.service';
import { DirectMessagesService } from '../direct-messages/direct-messages.service';
import { SocialService } from '../social/social.service';
import { ShareService } from './share.service';

const STREAM = 's1';
const SENDER = 'sender-1';

describe('ShareService', () => {
  const prisma = { stream: { findUnique: jest.fn() }, user: { findMany: jest.fn() } };
  const social = {
    isFollowing: jest.fn().mockResolvedValue(false),
    isFriend: jest.fn().mockResolvedValue(false),
    blockedEitherWayUserIds: jest.fn().mockResolvedValue([]),
  };
  const directMessages = { shareLive: jest.fn().mockResolvedValue({}) };
  const rateLimit = { take: jest.fn().mockResolvedValue(0) };
  const redisClient = {
    smembers: jest.fn().mockResolvedValue([]),
    sadd: jest.fn(),
    expire: jest.fn(),
  };
  const redis = { getClient: () => redisClient } as unknown as RedisService;
  const events = { emit: jest.fn() };

  const service = () =>
    new ShareService(
      prisma as unknown as PrismaService,
      social as unknown as SocialService,
      rateLimit as unknown as RateLimitService,
      redis,
      events as never,
      directMessages as unknown as DirectMessagesService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimit.take.mockResolvedValue(0);
    redisClient.smembers.mockResolvedValue([]);
    social.blockedEitherWayUserIds.mockResolvedValue([]);
    social.isFriend.mockResolvedValue(false);
    directMessages.shareLive.mockResolvedValue({});
    // Every id asked about is an active account.
    prisma.user.findMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
      Promise.resolve(where.id.in.map((id) => ({ id }))),
    );
    prisma.stream.findUnique.mockResolvedValue({
      status: StreamStatus.LIVE,
      hostId: 'host-1',
      visibility: StreamVisibility.PUBLIC,
    });
  });

  it('404s inviting to a stream that is not live', async () => {
    prisma.stream.findUnique.mockResolvedValue({ status: StreamStatus.ENDED });

    await expect(service().sendInvites(STREAM, SENDER, ['u1'])).rejects.toThrow(NotFoundException);
  });

  it('rejects when the per-sender rate limit is hit', async () => {
    rateLimit.take.mockResolvedValue(5000);

    await expect(service().sendInvites(STREAM, SENDER, ['u1'])).rejects.toThrow(
      BadRequestException,
    );
  });

  it('never invites yourself, silently', async () => {
    const result = await service().sendInvites(STREAM, SENDER, [SENDER]);

    expect(result).toEqual({ invited: [], sentOnce: [] });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('invites anyone, friend or not, and emits stream.invite_sent', async () => {
    const result = await service().sendInvites(STREAM, SENDER, ['f1', 'f2']);

    expect(result).toEqual({ invited: ['f1', 'f2'], sentOnce: ['f1', 'f2'] });
    expect(redisClient.sadd).toHaveBeenCalledWith(`invite:${STREAM}:${SENDER}`, 'f1', 'f2');
    expect(events.emit).toHaveBeenCalledWith(DomainEvents.StreamInviteSent, {
      streamId: STREAM,
      senderId: SENDER,
      recipientIds: ['f1', 'f2'],
    });
  });

  it("invites to a friends' live only friends who are the host's friends too", async () => {
    prisma.stream.findUnique.mockResolvedValue({
      status: StreamStatus.LIVE,
      hostId: 'host-1',
      visibility: StreamVisibility.FRIENDS,
    });
    // f1 and the host follow each other; f2 only follows the host.
    social.isFollowing.mockImplementation(
      async (follower: string, followee: string) =>
        follower === 'f1' || followee === 'f1' || (follower === 'f2' && followee === 'host-1'),
    );

    await expect(service().sendInvites(STREAM, SENDER, ['f1', 'f2'])).resolves.toEqual({
      invited: ['f1'],
      sentOnce: ['f1'],
    });
  });

  it('sends each person a live only once', async () => {
    redisClient.smembers.mockResolvedValue(['f1']);

    await expect(service().sendInvites(STREAM, SENDER, ['f1', 'f2'])).resolves.toEqual({
      invited: ['f2'],
      sentOnce: ['f1', 'f2'],
    });
  });

  it("skips anyone blocked by or blocking the sender or the host, and accounts that aren't active", async () => {
    social.blockedEitherWayUserIds.mockImplementation(async (id: string) =>
      id === SENDER ? ['b1'] : id === 'host-1' ? ['b2'] : [],
    );
    prisma.user.findMany.mockResolvedValue([{ id: 'b1' }, { id: 'b2' }, { id: 'ok' }]);

    await expect(
      service().sendInvites(STREAM, SENDER, ['b1', 'b2', 'suspended', 'ok']),
    ).resolves.toEqual({ invited: ['ok'], sentOnce: ['ok'] });
  });

  it('refuses once the per-stream cap is already used up', async () => {
    redisClient.smembers.mockResolvedValue(Array.from({ length: 20 }, (_, i) => `already-${i}`));

    await expect(service().sendInvites(STREAM, SENDER, ['new-friend'])).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('only invites up to the remaining room under the cap', async () => {
    redisClient.smembers.mockResolvedValue(Array.from({ length: 19 }, (_, i) => `already-${i}`));

    const result = await service().sendInvites(STREAM, SENDER, ['f1', 'f2']);

    expect(result).toEqual({ invited: ['f1'], sentOnce: ['f1'] });
  });

  describe('people who follow each other', () => {
    beforeEach(() =>
      social.isFriend.mockImplementation(async (_: string, id: string) => id.startsWith('friend')),
    );

    it('may be sent the same live again and again, outside the cap', async () => {
      redisClient.smembers.mockResolvedValue(Array.from({ length: 20 }, (_, i) => `already-${i}`));

      await expect(service().sendInvites(STREAM, SENDER, ['friend-1'])).resolves.toEqual({
        invited: ['friend-1'],
        sentOnce: [],
      });
      await expect(service().sendInvites(STREAM, SENDER, ['friend-1'])).resolves.toEqual({
        invited: ['friend-1'],
        sentOnce: [],
      });
      expect(redisClient.sadd).not.toHaveBeenCalled();
    });

    it('still get it when the others are over the cap', async () => {
      redisClient.smembers.mockResolvedValue(Array.from({ length: 20 }, (_, i) => `already-${i}`));

      await expect(
        service().sendInvites(STREAM, SENDER, ['friend-1', 'stranger']),
      ).resolves.toEqual({
        invited: ['friend-1'],
        sentOnce: [],
      });
    });

    it('while someone who only follows one way gets it once', async () => {
      redisClient.smembers.mockResolvedValue(['one-way']);

      await expect(service().sendInvites(STREAM, SENDER, ['friend-1', 'one-way'])).resolves.toEqual(
        {
          invited: ['friend-1'],
          sentOnce: ['one-way'],
        },
      );
    });
  });

  it("puts each live sent in the recipient's private chat", async () => {
    await service().sendInvites(STREAM, SENDER, ['f1', 'f2']);

    expect(directMessages.shareLive).toHaveBeenCalledWith(SENDER, 'f1', STREAM);
    expect(directMessages.shareLive).toHaveBeenCalledWith(SENDER, 'f2', STREAM);
  });

  it("still sends the live when it can't be put in a chat", async () => {
    directMessages.shareLive.mockRejectedValue(new Error('db down'));

    await expect(service().sendInvites(STREAM, SENDER, ['f1'])).resolves.toEqual({
      invited: ['f1'],
      sentOnce: ['f1'],
    });
    expect(events.emit).toHaveBeenCalledWith(DomainEvents.StreamInviteSent, expect.anything());
  });
});
