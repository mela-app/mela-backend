import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StreamStatus } from '@prisma/client';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { RedisService } from '../common/redis/redis.service';
import { SocialService } from '../social/social.service';
import { ShareService } from './share.service';

const STREAM = 's1';
const SENDER = 'sender-1';

describe('ShareService', () => {
  const prisma = { stream: { findUnique: jest.fn() } };
  const social = { isFriend: jest.fn() };
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
    );

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimit.take.mockResolvedValue(0);
    redisClient.smembers.mockResolvedValue([]);
    prisma.stream.findUnique.mockResolvedValue({ status: StreamStatus.LIVE });
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

  it('drops non-friends and never invites yourself, silently', async () => {
    social.isFriend.mockResolvedValueOnce(false); // u1 not a friend
    const result = await service().sendInvites(STREAM, SENDER, ['u1', SENDER]);

    expect(result).toEqual({ invited: [] });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('invites friends and emits stream.invite_sent', async () => {
    social.isFriend.mockResolvedValue(true);

    const result = await service().sendInvites(STREAM, SENDER, ['f1', 'f2']);

    expect(result).toEqual({ invited: ['f1', 'f2'] });
    expect(redisClient.sadd).toHaveBeenCalledWith(`invite:${STREAM}:${SENDER}`, 'f1', 'f2');
    expect(events.emit).toHaveBeenCalledWith(DomainEvents.StreamInviteSent, {
      streamId: STREAM,
      senderId: SENDER,
      recipientIds: ['f1', 'f2'],
    });
  });

  it('refuses once the per-stream cap is already used up', async () => {
    social.isFriend.mockResolvedValue(true);
    redisClient.smembers.mockResolvedValue(Array.from({ length: 20 }, (_, i) => `already-${i}`));

    await expect(service().sendInvites(STREAM, SENDER, ['new-friend'])).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('only invites up to the remaining room under the cap', async () => {
    social.isFriend.mockResolvedValue(true);
    redisClient.smembers.mockResolvedValue(Array.from({ length: 19 }, (_, i) => `already-${i}`));

    const result = await service().sendInvites(STREAM, SENDER, ['f1', 'f2']);

    expect(result).toEqual({ invited: ['f1'] });
  });
});
