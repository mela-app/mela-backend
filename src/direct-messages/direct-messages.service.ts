import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { BannedPhrasesService } from '../chat/banned-phrases.service';
import { ChatTextError, cleanChatText } from '../chat/chat-text';
import { hasDisallowedLink, parseLinkDomains } from '../chat/link-policy';
import {
  DirectMessagePerson,
  DirectMessageSentPayload,
  DirectMessageSnapshot,
  DirectMessagesReadPayload,
  DomainEvents,
} from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimit, RateLimitService } from '../common/rate-limit/rate-limit.service';
import { Page, SocialService } from '../social/social.service';
import { notBlockedEitherWayWith } from '../social/block-filters';
import { ConversationHistoryQueryDto } from './dto/conversation-history-query.dto';

/** Longer than live chat's 200: a conversation, not a comment on a live. */
export const DIRECT_MESSAGE_MAX_LENGTH = 1000;

/** Five at once, then one a second - per sender, across all their conversations. */
export const DIRECT_MESSAGE_RATE_LIMIT: RateLimit = { capacity: 5, refillMs: 1000 };

const PERSON_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;

const MESSAGE_SELECT = {
  id: true,
  senderId: true,
  recipientId: true,
  text: true,
  clientId: true,
  createdAt: true,
  readAt: true,
} satisfies Prisma.DirectMessageSelect;

const TEXT_ERRORS: Record<ChatTextError, string> = {
  MESSAGE_EMPTY: 'Write something first',
  MESSAGE_TOO_LONG: `Messages can be at most ${DIRECT_MESSAGE_MAX_LENGTH} characters`,
};

/** One row of the inbox: the other person, and where things stand with them. */
export interface ConversationView {
  user: DirectMessagePerson;
  lastMessage: DirectMessageSnapshot | null;
  // Messages from them this user hasn't read.
  unreadCount: number;
  // Following each other right now; otherwise the history stays readable, but nothing new can be sent.
  canMessage: boolean;
}

export interface ConversationHistory {
  user: DirectMessagePerson;
  canMessage: boolean;
  // Oldest first.
  messages: DirectMessageSnapshot[];
  hasEarlier: boolean;
}

/**
 * Direct messages between friends - two people who follow each other. The
 * inbox, a conversation's history, sending, and read receipts; realtime
 * delivery goes through domain events. See docs/features/messages.md.
 */
@Injectable()
export class DirectMessagesService {
  private readonly linkDomains: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly social: SocialService,
    private readonly bannedPhrases: BannedPhrasesService,
    private readonly rateLimit: RateLimitService,
    private readonly events: EventEmitter2,
    config: ConfigService,
  ) {
    this.linkDomains = parseLinkDomains(config.get<string>('CHAT_LINK_DOMAINS'));
  }

  /**
   * Live chat's pipeline (docs/features/chat.md) on a longer message: clean
   * the text, the phrase filter, the sender's pace, the link policy - but
   * first, only between friends. A resend with the same `clientId` gets the
   * stored message back instead of a second one.
   */
  async send(
    senderId: string,
    recipientId: string,
    rawText: string,
    clientId?: string,
  ): Promise<DirectMessageSnapshot> {
    assertNotSelf(senderId, recipientId);
    const cleaned = cleanChatText(rawText, DIRECT_MESSAGE_MAX_LENGTH);
    if ('error' in cleaned) {
      throw new BadRequestException({ message: TEXT_ERRORS[cleaned.error], code: cleaned.error });
    }

    if (clientId) {
      const earlier = await this.findSent(senderId, clientId);
      if (earlier) return this.resent(earlier, recipientId);
    }

    const people = await this.prisma.user.findMany({
      where: { id: { in: [senderId, recipientId] } },
      select: PERSON_SELECT,
    });
    const sender = people.find((person) => person.id === senderId);
    const recipient = people.find((person) => person.id === recipientId);
    if (!sender || !recipient) throw new NotFoundException('User not found');
    if (!(await this.social.isFriend(senderId, recipientId))) {
      throw new ForbiddenException({
        message: 'You can message each other once you follow each other',
        code: 'NOT_FRIENDS',
      });
    }

    const phraseMatches = await this.bannedPhrases.match(cleaned.text);
    if (phraseMatches.some((match) => match.severity === 'REJECT')) {
      throw new BadRequestException({
        message: "This message can't be sent",
        code: 'MESSAGE_BLOCKED',
      });
    }
    const retryAfterMs = await this.rateLimit.take(
      `ratelimit:dm:${senderId}`,
      DIRECT_MESSAGE_RATE_LIMIT,
    );
    if (retryAfterMs > 0) {
      throw new HttpException(
        { message: 'Slow down a little', code: 'RATE_LIMITED', retryAfterMs },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (hasDisallowedLink(cleaned.text, this.linkDomains)) {
      throw new BadRequestException({
        message: "Links to other sites can't be sent",
        code: 'LINK_NOT_ALLOWED',
      });
    }

    const text =
      phraseMatches.length > 0 ? await this.bannedPhrases.mask(cleaned.text) : cleaned.text;
    let message: DirectMessageSnapshot;
    try {
      message = await this.store(senderId, recipientId, text, clientId);
    } catch (error) {
      // The same clientId sent twice at once: the other request stored it.
      const earlier =
        clientId && isUniqueViolation(error) ? await this.findSent(senderId, clientId) : null;
      if (earlier) return this.resent(earlier, recipientId);
      throw error;
    }

    this.events.emit(DomainEvents.DirectMessageSent, {
      message,
      sender,
      recipient,
      recipientUnreadCount: await this.unreadTotal(recipientId),
    } satisfies DirectMessageSentPayload);
    return message;
  }

  /** The inbox: newest conversation first, without anyone blocked either way (plan §6.4). */
  async listConversations(
    userId: string,
    cursor?: string,
    limit = 30,
  ): Promise<Page<ConversationView>> {
    const rows = await this.prisma.conversation.findMany({
      where: {
        OR: [
          { userAId: userId, userB: notBlockedEitherWayWith(userId) },
          { userBId: userId, userA: notBlockedEitherWayWith(userId) },
        ],
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
      select: {
        id: true,
        userA: { select: PERSON_SELECT },
        userB: { select: PERSON_SELECT },
        messages: { orderBy: { id: 'desc' }, take: 1, select: MESSAGE_SELECT },
      },
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const partnerIds = page.map((row) => (row.userA.id === userId ? row.userB.id : row.userA.id));

    const [unread, following, followers] = await Promise.all([
      this.prisma.directMessage.groupBy({
        by: ['senderId'],
        where: { recipientId: userId, readAt: null, senderId: { in: partnerIds } },
        _count: { _all: true },
      }),
      this.prisma.follow.findMany({
        where: { followerId: userId, followeeId: { in: partnerIds } },
        select: { followeeId: true },
      }),
      this.prisma.follow.findMany({
        where: { followeeId: userId, followerId: { in: partnerIds } },
        select: { followerId: true },
      }),
    ]);
    const unreadBySender = new Map(unread.map((group) => [group.senderId, group._count._all]));
    const followingIds = new Set(following.map((row) => row.followeeId));
    const followerIds = new Set(followers.map((row) => row.followerId));

    return {
      items: page.map((row) => {
        const user = row.userA.id === userId ? row.userB : row.userA;
        return {
          user,
          lastMessage: row.messages[0] ?? null,
          unreadCount: unreadBySender.get(user.id) ?? 0,
          canMessage: followingIds.has(user.id) && followerIds.has(user.id),
        };
      }),
      hasMore,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /** The inbox badge: every unread message, except from anyone blocked either way. */
  async unreadCount(userId: string): Promise<{ count: number }> {
    return { count: await this.unreadTotal(userId) };
  }

  /** One conversation, oldest first - see ConversationHistoryQueryDto. Gone for someone the other side blocked. */
  async history(
    userId: string,
    otherId: string,
    query: ConversationHistoryQueryDto,
  ): Promise<ConversationHistory> {
    assertNotSelf(userId, otherId);
    const [user, blockedByOther] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: otherId },
        select: PERSON_SELECT,
      }),
      this.social.isBlockedByViewer(otherId, userId),
    ]);
    if (!user || blockedByOther) throw new NotFoundException('User not found');

    const [rows, canMessage] = await Promise.all([
      this.prisma.directMessage.findMany({
        where: { conversation: pairOf(userId, otherId), id: { lt: query.before } },
        // Newest first to pick the window; handed out oldest first.
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        select: MESSAGE_SELECT,
      }),
      this.social.isFriend(userId, otherId),
    ]);
    return {
      user,
      canMessage,
      messages: rows.slice(0, query.limit).reverse(),
      hasEarlier: rows.length > query.limit,
    };
  }

  /** Everything [partnerId] sent this reader so far is read - the partner's app shows "Seen". */
  async markRead(readerId: string, partnerId: string): Promise<{ ok: true; unreadCount: number }> {
    const readAt = new Date();
    const { count } = await this.prisma.directMessage.updateMany({
      where: { recipientId: readerId, senderId: partnerId, readAt: null },
      data: { readAt },
    });
    const unreadCount = await this.unreadTotal(readerId);
    if (count > 0) {
      this.events.emit(DomainEvents.DirectMessagesRead, {
        readerId,
        partnerId,
        readAt,
        readerUnreadCount: unreadCount,
      } satisfies DirectMessagesReadPayload);
    }
    return { ok: true, unreadCount };
  }

  // The pair's one conversation moves to the top of both inboxes.
  private store(senderId: string, recipientId: string, text: string, clientId?: string) {
    const pair = pairOf(senderId, recipientId);
    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.upsert({
        where: { userAId_userBId: pair },
        create: pair,
        update: { lastMessageAt: new Date() },
        select: { id: true },
      });
      return tx.directMessage.create({
        data: { conversationId: conversation.id, senderId, recipientId, text, clientId },
        select: MESSAGE_SELECT,
      });
    });
  }

  private findSent(senderId: string, clientId: string): Promise<DirectMessageSnapshot | null> {
    return this.prisma.directMessage.findUnique({
      where: { senderId_clientId: { senderId, clientId } },
      select: MESSAGE_SELECT,
    });
  }

  // A clientId names one message: reusing it for someone else is the app's mistake.
  private resent(earlier: DirectMessageSnapshot, recipientId: string): DirectMessageSnapshot {
    if (earlier.recipientId !== recipientId) {
      throw new BadRequestException({
        message: 'That message id is already used',
        code: 'CLIENT_ID_REUSED',
      });
    }
    return earlier;
  }

  private unreadTotal(userId: string): Promise<number> {
    return this.prisma.directMessage.count({
      // A blocked conversation is hidden, so it can't be opened to clear its count.
      where: {
        recipientId: userId,
        readAt: null,
        sender: notBlockedEitherWayWith(userId),
      },
    });
  }
}

/** The pair's one conversation row: the smaller id is always userA. */
function pairOf(userId: string, otherId: string): { userAId: string; userBId: string } {
  return userId < otherId
    ? { userAId: userId, userBId: otherId }
    : { userAId: otherId, userBId: userId };
}

function assertNotSelf(userId: string, otherId: string): void {
  if (userId === otherId) {
    throw new BadRequestException({
      message: "You can't message yourself",
      code: 'CANNOT_MESSAGE_SELF',
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
