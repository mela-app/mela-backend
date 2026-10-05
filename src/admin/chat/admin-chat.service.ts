import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { pageArgs, toPage } from '../../common/pagination/page-query.dto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { nameMatches, rangeOf } from '../day-range';
import { AdminChatHostsQueryDto, AdminHostChatQueryDto } from './admin-chat.dto';

const PERSON = {
  select: { id: true, username: true, displayName: true, avatarUrl: true },
} as const;

export type Person = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

/** A host's chat in the range, all their lives together. */
export interface HostRow {
  host: Person;
  liveCount: number;
  messageCount: number;
  firstMessageAt: Date;
  lastMessageAt: Date;
}

/**
 * Live chat in the admin console, arranged like private messages (docs/features/admin.md):
 * a day at a time, the hosts whose lives had chat that day, then one host's
 * chat across those lives. Chat in a live is public, so reading it isn't audited.
 */
@Injectable()
export class AdminChatService {
  constructor(private readonly prisma: PrismaService) {}

  /** Hosts whose lives had chat in the range, the latest message first. */
  async hosts(query: AdminChatHostsQueryDto) {
    const range = rangeOf(query);
    const q = query.q?.trim();
    // Chat only happens while a live runs, so these are the only lives to count.
    const streams = await this.prisma.stream.findMany({
      where: { ...runningDuring(range), ...(q ? { host: nameMatches(q) } : {}) },
      select: { id: true, host: PERSON },
    });
    const groups = streams.length
      ? await this.prisma.chatMessage.groupBy({
          by: ['streamId'],
          where: { streamId: { in: streams.map((stream) => stream.id) }, createdAt: range },
          _count: { _all: true },
          _min: { createdAt: true },
          _max: { createdAt: true },
        })
      : [];

    const hostOf = new Map(streams.map((stream) => [stream.id, stream.host]));
    const byHost = new Map<string, HostRow>();
    let messageCount = 0;
    for (const group of groups) {
      const host = hostOf.get(group.streamId);
      const first = group._min.createdAt;
      const last = group._max.createdAt;
      if (!host || !first || !last) continue;
      messageCount += group._count._all;
      const row = byHost.get(host.id);
      if (!row) {
        byHost.set(host.id, {
          host,
          liveCount: 1,
          messageCount: group._count._all,
          firstMessageAt: first,
          lastMessageAt: last,
        });
        continue;
      }
      row.liveCount += 1;
      row.messageCount += group._count._all;
      if (first < row.firstMessageAt) row.firstMessageAt = first;
      if (last > row.lastMessageAt) row.lastMessageAt = last;
    }

    const rows = [...byHost.values()].sort(
      (a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime(),
    );
    const { skip, take } = pageArgs(query);
    return { ...toPage(rows.slice(skip, skip + take), rows.length, query), messageCount };
  }

  /**
   * One host's chat in the range, oldest first, across every live of theirs -
   * every moderation status, as in a live's own chat log.
   */
  async hostChat(hostId: string, query: AdminHostChatQueryDto) {
    const range = rangeOf(query);
    const host = await this.prisma.user.findUnique({ where: { id: hostId }, ...PERSON });
    if (!host) throw new NotFoundException('User not found');

    const streams = await this.prisma.stream.findMany({
      where: { hostId, ...runningDuring(range) },
      orderBy: { startedAt: 'asc' },
      select: {
        id: true,
        title: true,
        category: true,
        status: true,
        startedAt: true,
        endedAt: true,
      },
    });
    if (streams.length === 0) return { host, lives: [], messages: [], nextCursor: null };

    const q = query.q?.trim();
    const where: Prisma.ChatMessageWhereInput = {
      streamId: { in: streams.map((stream) => stream.id) },
      createdAt: range,
      ...(query.status ? { moderationStatus: query.status } : {}),
      ...(q ? { text: { contains: q, mode: 'insensitive' } } : {}),
    };
    const [rows, perLive] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { ...where, ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: query.limit + 1,
        select: {
          id: true,
          streamId: true,
          text: true,
          imageUrl: true,
          moderationStatus: true,
          flaggedReason: true,
          createdAt: true,
          user: PERSON,
        },
      }),
      this.prisma.chatMessage.groupBy({ by: ['streamId'], where, _count: { _all: true } }),
    ]);
    const hasMore = rows.length > query.limit;
    const messages = rows.slice(0, query.limit);
    const counts = new Map(perLive.map((group) => [group.streamId, group._count._all]));

    return {
      host,
      // The lives with matching chat, in the order they started.
      lives: streams.flatMap((stream) => {
        const messageCount = counts.get(stream.id);
        return messageCount ? [{ ...stream, messageCount }] : [];
      }),
      messages,
      nextCursor: hasMore ? messages[messages.length - 1].id : null,
    };
  }
}

/** Lives that were running at some point in [range]. */
function runningDuring(range: { gte: Date; lte: Date }): Prisma.StreamWhereInput {
  return {
    startedAt: { lte: range.lte },
    OR: [{ endedAt: null }, { endedAt: { gte: range.gte } }],
  };
}
