import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { BannedPhrasesService } from '../chat/banned-phrases.service';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { SocialService } from '../social/social.service';
import { DIRECT_MESSAGE_RATE_LIMIT, DirectMessagesService } from './direct-messages.service';

// Ana's id sorts first, so a conversation between them is stored as (Ana, Ben).
const ANA = '1a1a1a1a-0000-4000-8000-000000000001';
const BEN = '2b2b2b2b-0000-4000-8000-000000000002';
const CAL = '3c3c3c3c-0000-4000-8000-000000000003';

const person = (id: string, name: string) => ({
  id,
  username: name.toLowerCase(),
  displayName: name,
  avatarUrl: null,
});
const ana = person(ANA, 'Ana');
const ben = person(BEN, 'Ben');
const cal = person(CAL, 'Cal');

const message = (id: string, senderId: string, recipientId: string, text = 'hello') => ({
  id,
  senderId,
  recipientId,
  text,
  clientId: null,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  readAt: null,
});

describe('DirectMessagesService', () => {
  const prisma = {
    user: { findMany: jest.fn(), findUnique: jest.fn() },
    conversation: { upsert: jest.fn(), findMany: jest.fn() },
    directMessage: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    follow: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const social = { isFriend: jest.fn(), isBlockedByViewer: jest.fn() };
  const bannedPhrases = { match: jest.fn(), mask: jest.fn() };
  const rateLimit = { take: jest.fn() };
  const events = { emit: jest.fn() };
  const config = {
    get: (key: string) => (key === 'CHAT_LINK_DOMAINS' ? 'mela.example' : undefined),
  };

  const service = () =>
    new DirectMessagesService(
      prisma as unknown as PrismaService,
      social as unknown as SocialService,
      bannedPhrases as unknown as BannedPhrasesService,
      rateLimit as unknown as RateLimitService,
      events as unknown as EventEmitter2,
      config as unknown as ConfigService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    // Interactive: the callback gets the same client as its transaction.
    prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));
    prisma.user.findMany.mockResolvedValue([ana, ben]);
    prisma.conversation.upsert.mockResolvedValue({ id: 'conversation-1' });
    prisma.directMessage.findUnique.mockResolvedValue(null);
    prisma.directMessage.create.mockImplementation(
      ({
        data,
      }: {
        data: { senderId: string; recipientId: string; text: string; clientId?: string };
      }) =>
        Promise.resolve({
          ...message('m1', data.senderId, data.recipientId, data.text),
          clientId: data.clientId ?? null,
        }),
    );
    prisma.directMessage.count.mockResolvedValue(3);
    social.isFriend.mockResolvedValue(true);
    social.isBlockedByViewer.mockResolvedValue(false);
    bannedPhrases.match.mockResolvedValue([]);
    rateLimit.take.mockResolvedValue(0);
  });

  async function refusal(promise: Promise<unknown>): Promise<{ status: number; code?: string }> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (!(error instanceof HttpException))
      throw new Error(`expected an HttpException, got ${String(error)}`);
    const body = error.getResponse();
    return {
      status: error.getStatus(),
      code: typeof body === 'object' ? (body as { code?: string }).code : undefined,
    };
  }

  describe('send', () => {
    it('stores a message between friends in their one conversation, and tells both apps', async () => {
      const sent = await service().send(BEN, ANA, '  hello   Ana ', 'client-1');

      expect(sent).toMatchObject({
        senderId: BEN,
        recipientId: ANA,
        text: 'hello Ana',
        clientId: 'client-1',
      });
      // The same row whoever writes first: the smaller id is always userA.
      expect(prisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userAId_userBId: { userAId: ANA, userBId: BEN } },
          create: { userAId: ANA, userBId: BEN },
        }),
      );
      expect(prisma.directMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            conversationId: 'conversation-1',
            senderId: BEN,
            recipientId: ANA,
            text: 'hello Ana',
            clientId: 'client-1',
          },
        }),
      );
      expect(rateLimit.take).toHaveBeenCalledWith(`ratelimit:dm:${BEN}`, DIRECT_MESSAGE_RATE_LIMIT);
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.DirectMessageSent, {
        message: sent,
        sender: ben,
        recipient: ana,
        recipientUnreadCount: 3,
      });
    });

    it('only between people who follow each other', async () => {
      social.isFriend.mockResolvedValue(false);

      expect(await refusal(service().send(BEN, ANA, 'hello'))).toEqual({
        status: 403,
        code: 'NOT_FRIENDS',
      });
      expect(social.isFriend).toHaveBeenCalledWith(BEN, ANA);
      expect(prisma.directMessage.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('refuses messaging yourself, and someone who does not exist', async () => {
      expect(await refusal(service().send(ANA, ANA, 'hello'))).toEqual({
        status: 400,
        code: 'CANNOT_MESSAGE_SELF',
      });

      prisma.user.findMany.mockResolvedValue([ben]);
      await expect(service().send(BEN, ANA, 'hello')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses an empty message, and one longer than 1000 characters', async () => {
      expect(await refusal(service().send(BEN, ANA, ' \n '))).toEqual({
        status: 400,
        code: 'MESSAGE_EMPTY',
      });
      expect(await refusal(service().send(BEN, ANA, 'ab'.repeat(501)))).toEqual({
        status: 400,
        code: 'MESSAGE_TOO_LONG',
      });

      await service().send(BEN, ANA, 'ab'.repeat(500));
      expect(prisma.directMessage.create).toHaveBeenCalledTimes(1);
    });

    it("runs live chat's phrase filter: a REJECT phrase is refused, a MASK phrase is masked", async () => {
      bannedPhrases.match.mockResolvedValueOnce([{ phrase: 'scam', severity: 'REJECT' }]);
      expect(await refusal(service().send(BEN, ANA, 'a scam'))).toEqual({
        status: 400,
        code: 'MESSAGE_BLOCKED',
      });

      bannedPhrases.match.mockResolvedValueOnce([{ phrase: 'darn', severity: 'MASK' }]);
      bannedPhrases.mask.mockResolvedValueOnce('oh ****');
      expect(await service().send(BEN, ANA, 'oh darn')).toMatchObject({ text: 'oh ****' });
    });

    it("only lets through links to the platform's own domains", async () => {
      expect(await refusal(service().send(BEN, ANA, 'see evil.example/win'))).toEqual({
        status: 400,
        code: 'LINK_NOT_ALLOWED',
      });

      expect(await service().send(BEN, ANA, 'see https://mela.example/live/1')).toMatchObject({
        text: 'see https://mela.example/live/1',
      });
    });

    it('slows down a sender going too fast', async () => {
      rateLimit.take.mockResolvedValue(700);

      expect(await refusal(service().send(BEN, ANA, 'hello'))).toEqual({
        status: 429,
        code: 'RATE_LIMITED',
      });
      expect(prisma.directMessage.create).not.toHaveBeenCalled();
    });

    it('a resend with the same clientId gets the stored message back, sent only once', async () => {
      const earlier = { ...message('m0', BEN, ANA), clientId: 'client-1' };
      prisma.directMessage.findUnique.mockResolvedValue(earlier);

      expect(await service().send(BEN, ANA, 'hello', 'client-1')).toBe(earlier);
      expect(prisma.directMessage.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { senderId_clientId: { senderId: BEN, clientId: 'client-1' } },
        }),
      );
      expect(prisma.directMessage.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('a clientId already used for someone else is refused', async () => {
      prisma.directMessage.findUnique.mockResolvedValue({
        ...message('m0', BEN, CAL),
        clientId: 'client-1',
      });

      expect(await refusal(service().send(BEN, ANA, 'hello', 'client-1'))).toEqual({
        status: 400,
        code: 'CLIENT_ID_REUSED',
      });
    });

    it('two sends of one clientId at once store one message, and both get it back', async () => {
      const winner = { ...message('m0', BEN, ANA), clientId: 'client-1' };
      prisma.directMessage.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      prisma.directMessage.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      expect(await service().send(BEN, ANA, 'hello', 'client-1')).toBe(winner);
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('listConversations', () => {
    it('newest first: the other person, the last message, unread counts, and who can still be messaged', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        { id: 'conversation-2', userA: ana, userB: cal, messages: [message('m9', ANA, CAL)] },
        { id: 'conversation-1', userA: ana, userB: ben, messages: [message('m5', BEN, ANA)] },
      ]);
      prisma.directMessage.groupBy.mockResolvedValue([{ senderId: BEN, _count: { _all: 2 } }]);
      // Ana follows both; only Ben follows her back.
      prisma.follow.findMany
        .mockResolvedValueOnce([{ followeeId: BEN }, { followeeId: CAL }])
        .mockResolvedValueOnce([{ followerId: BEN }]);

      const page = await service().listConversations(ANA);

      expect(page).toEqual({
        items: [
          { user: cal, lastMessage: message('m9', ANA, CAL), unreadCount: 0, canMessage: false },
          { user: ben, lastMessage: message('m5', BEN, ANA), unreadCount: 2, canMessage: true },
        ],
        hasMore: false,
        nextCursor: null,
      });
      const query = prisma.conversation.findMany.mock.calls[0][0] as Record<string, unknown>;
      // Anyone blocked either way is left out, whichever side of the pair they're on.
      const notBlocked = {
        blockedBy: { none: { blockerId: ANA } },
        blocksMade: { none: { blockedId: ANA } },
      };
      expect(query.where).toEqual({
        OR: [
          { userAId: ANA, userB: notBlocked },
          { userBId: ANA, userA: notBlocked },
        ],
      });
      expect(query.orderBy).toEqual([{ lastMessageAt: 'desc' }, { id: 'desc' }]);
    });

    it('pages by conversation', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        { id: 'conversation-3', userA: ana, userB: ben, messages: [] },
        { id: 'conversation-2', userA: ana, userB: cal, messages: [] },
      ]);
      prisma.directMessage.groupBy.mockResolvedValue([]);
      prisma.follow.findMany.mockResolvedValue([]);

      const page = await service().listConversations(ANA, 'conversation-4', 1);

      expect(page.items).toHaveLength(1);
      expect(page).toMatchObject({ hasMore: true, nextCursor: 'conversation-3' });
      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: { id: 'conversation-4' }, skip: 1, take: 2 }),
      );
    });
  });

  describe('history', () => {
    it('the latest messages oldest first, and whether they can still message', async () => {
      prisma.user.findUnique.mockResolvedValue(ben);
      prisma.directMessage.findMany.mockResolvedValue([
        message('m3', BEN, ANA),
        message('m2', ANA, BEN),
        message('m1', BEN, ANA),
      ]);
      social.isFriend.mockResolvedValue(false);

      const history = await service().history(ANA, BEN, { limit: 2 });

      expect(history).toEqual({
        user: ben,
        canMessage: false,
        messages: [message('m2', ANA, BEN), message('m3', BEN, ANA)],
        hasEarlier: true,
      });
      expect(prisma.directMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversation: { userAId: ANA, userBId: BEN }, id: { lt: undefined } },
          orderBy: { id: 'desc' },
          take: 3,
        }),
      );
    });

    it('someone who does not exist is a 404, and yourself is refused', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service().history(ANA, BEN, { limit: 50 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service().history(ANA, ANA, { limit: 50 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('is a 404 for someone the other person blocked', async () => {
      prisma.user.findUnique.mockResolvedValue(ben);
      social.isBlockedByViewer.mockResolvedValue(true);

      await expect(service().history(ANA, BEN, { limit: 50 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(social.isBlockedByViewer).toHaveBeenCalledWith(BEN, ANA);
      expect(prisma.directMessage.findMany).not.toHaveBeenCalled();
    });
  });

  describe('markRead', () => {
    it("reads what the partner sent, and tells both apps with the reader's new total", async () => {
      prisma.directMessage.updateMany.mockResolvedValue({ count: 2 });
      prisma.directMessage.count.mockResolvedValue(1);

      expect(await service().markRead(ANA, BEN)).toEqual({ ok: true, unreadCount: 1 });
      expect(prisma.directMessage.updateMany).toHaveBeenCalledWith({
        where: { recipientId: ANA, senderId: BEN, readAt: null },
        data: { readAt: expect.any(Date) },
      });
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.DirectMessagesRead, {
        readerId: ANA,
        partnerId: BEN,
        readAt: expect.any(Date),
        readerUnreadCount: 1,
      });
    });

    it('with nothing unread, tells no one', async () => {
      prisma.directMessage.updateMany.mockResolvedValue({ count: 0 });

      await service().markRead(ANA, BEN);

      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  it('the unread badge counts every unread message except from anyone blocked either way', async () => {
    prisma.directMessage.count.mockResolvedValue(4);

    expect(await service().unreadCount(ANA)).toEqual({ count: 4 });
    expect(prisma.directMessage.count).toHaveBeenCalledWith({
      where: {
        recipientId: ANA,
        readAt: null,
        sender: {
          blockedBy: { none: { blockerId: ANA } },
          blocksMade: { none: { blockedId: ANA } },
        },
      },
    });
  });
});
