import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { pageArgs, toPage } from '../../common/pagination/page-query.dto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminPrincipal } from '../admin.guard';
import { nameMatches, rangeOf } from '../day-range';
import { AdminConversationsQueryDto, AdminTranscriptQueryDto } from './admin-messages.dto';

const PERSON = {
  select: { id: true, username: true, displayName: true, avatarUrl: true },
} as const;

/**
 * Direct messages in the admin console (docs/features/messages.md): who
 * wrote to whom in a stretch of time, without the text; then, opened one at
 * a time, a conversation's messages - which the audit trail records.
 */
@Injectable()
export class AdminMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Conversations with messages in the range, the latest activity first. */
  async conversations(query: AdminConversationsQueryDto) {
    const where = messagesWhere(query);
    const [groups, everyGroup, messageCount] = await Promise.all([
      this.prisma.directMessage.groupBy({
        by: ['conversationId'],
        where,
        _count: { _all: true },
        _min: { createdAt: true },
        _max: { createdAt: true },
        orderBy: { _max: { createdAt: 'desc' } },
        ...pageArgs(query),
      }),
      this.prisma.directMessage.groupBy({ by: ['conversationId'], where }),
      this.prisma.directMessage.count({ where }),
    ]);
    const conversations = await this.prisma.conversation.findMany({
      where: { id: { in: groups.map((group) => group.conversationId) } },
      select: { id: true, userA: PERSON, userB: PERSON },
    });
    const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    const items = groups.flatMap((group) => {
      const conversation = byId.get(group.conversationId);
      if (!conversation) return [];
      return [
        {
          id: conversation.id,
          people: [conversation.userA, conversation.userB],
          messageCount: group._count._all,
          firstMessageAt: group._min.createdAt,
          lastMessageAt: group._max.createdAt,
        },
      ];
    });
    return { ...toPage(items, everyGroup.length, query), messageCount };
  }

  /** One conversation's messages in the range, oldest first. Opening it is recorded. */
  async transcript(admin: AdminPrincipal, conversationId: string, query: AdminTranscriptQueryDto) {
    const range = rangeOf(query);
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, userA: PERSON, userB: PERSON },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    const rows = await this.prisma.directMessage.findMany({
      where: {
        conversationId,
        createdAt: range,
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      select: { id: true, senderId: true, text: true, createdAt: true, readAt: true },
    });
    const hasMore = rows.length > query.limit;
    const messages = rows.slice(0, query.limit);

    // The pages after the first belong to the same look.
    if (!query.cursor) {
      const { userA, userB } = conversation;
      await this.audit.record({
        action: 'admin.private_messages_viewed',
        actorId: admin.id,
        target: {
          type: 'CONVERSATION',
          id: conversation.id,
          label: `@${userA.username} and @${userB.username}`,
        },
        metadata: {
          from: range.gte.toISOString(),
          to: range.lte.toISOString(),
          userIds: [userA.id, userB.id],
        },
      });
    }

    return {
      id: conversation.id,
      people: [conversation.userA, conversation.userB],
      messages,
      nextCursor: hasMore ? messages[messages.length - 1].id : null,
    };
  }
}

function messagesWhere(query: AdminConversationsQueryDto): Prisma.DirectMessageWhereInput {
  const and: Prisma.DirectMessageWhereInput[] = [{ createdAt: rangeOf(query) }];
  if (query.userId) and.push({ OR: [{ senderId: query.userId }, { recipientId: query.userId }] });
  const q = query.q?.trim();
  if (q) and.push({ OR: [{ sender: nameMatches(q) }, { recipient: nameMatches(q) }] });
  return { AND: and };
}
