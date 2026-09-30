import { Injectable, NotFoundException } from '@nestjs/common';
import { ModeratorStatus, Prisma, StreamGuestStatus, StreamStatus } from '@prisma/client';
import { ChatService } from '../../chat/chat.service';
import { pageArgs, toPage } from '../../common/pagination/page-query.dto';
import { LivePresenceService } from '../../common/presence/live-presence.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StreamsService } from '../../streams/streams.service';
import { AdminPrincipal } from '../admin.guard';
import { AdminChatLogQueryDto, AdminStreamsQueryDto } from './admin-streams.dto';

const PERSON_SELECT = { select: { id: true, username: true, displayName: true, avatarUrl: true } } as const;

const STREAM_ROW_SELECT = {
  id: true,
  title: true,
  category: true,
  status: true,
  startedAt: true,
  endedAt: true,
  endedReason: true,
  peakViewerCount: true,
  likeCount: true,
  videoProvider: true,
  lockedAt: true,
  host: PERSON_SELECT,
} as const;

/**
 * Every live, running or over (plan §6.8 - history is admin-only since
 * Phase 1.5), with its chat log, and the kill switch.
 */
@Injectable()
export class AdminStreamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: LivePresenceService,
    private readonly streams: StreamsService,
    private readonly chat: ChatService,
  ) {}

  async list(query: AdminStreamsQueryDto) {
    const q = query.q?.trim();
    const where: Prisma.StreamWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.hostId ? { hostId: query.hostId } : {}),
      ...(query.from || query.to
        ? {
            startedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { category: { contains: q, mode: 'insensitive' } },
              { host: { username: { contains: q, mode: 'insensitive' } } },
              { host: { displayName: { contains: q, mode: 'insensitive' } } },
              { id: q },
            ],
          }
        : {}),
    };
    const order = query.order ?? 'desc';
    const orderBy: Prisma.StreamOrderByWithRelationInput[] =
      query.sort === 'peakViewerCount'
        ? [{ peakViewerCount: order }, { startedAt: 'desc' }]
        : query.sort === 'likeCount'
          ? [{ likeCount: order }, { startedAt: 'desc' }]
          : [{ startedAt: order }];

    const [rows, total] = await Promise.all([
      this.prisma.stream.findMany({ where, orderBy, select: STREAM_ROW_SELECT, ...pageArgs(query) }),
      this.prisma.stream.count({ where }),
    ]);

    const liveIds = rows.filter((row) => row.status === StreamStatus.LIVE).map((row) => row.id);
    const viewerCounts = await this.presence.viewerCounts(liveIds).catch(() => new Map<string, number>());
    return toPage(
      rows.map((row) => ({
        ...row,
        viewerCount: row.status === StreamStatus.LIVE ? (viewerCounts.get(row.id) ?? 0) : null,
      })),
      total,
      query,
    );
  }

  async detail(streamId: string) {
    const stream = await this.prisma.stream.findUnique({
      where: { id: streamId },
      select: {
        ...STREAM_ROW_SELECT,
        layout: true,
        channelName: true,
        lockedReason: true,
        lockedBy: PERSON_SELECT,
        _count: { select: { chatMessages: true, roomBans: true } },
      },
    });
    if (!stream) throw new NotFoundException('Stream not found');

    const isLive = stream.status === StreamStatus.LIVE;
    const [live, deletedMessages, guests, moderators] = await Promise.all([
      isLive
        ? Promise.all([
            this.presence.viewerCount(streamId),
            this.presence.likeCount(streamId),
            this.presence.isPaused(streamId),
          ]).catch(() => null)
        : Promise.resolve(null),
      this.prisma.chatMessage.count({
        where: { streamId, moderationStatus: { not: 'VISIBLE' } },
      }),
      this.prisma.streamGuest.findMany({
        where: { streamId },
        orderBy: { joinedAt: 'asc' },
        select: { status: true, joinedAt: true, leftAt: true, micForceMuted: true, user: PERSON_SELECT },
      }),
      this.prisma.moderator.findMany({
        where: { streamId },
        orderBy: { grantedAt: 'asc' },
        select: { status: true, capabilities: true, grantedAt: true, revokedAt: true, user: PERSON_SELECT },
      }),
    ]);

    const { _count: counts, ...rest } = stream;
    return {
      ...rest,
      viewerCount: live ? live[0] : null,
      likeCount: live ? live[1] : stream.likeCount,
      paused: live ? live[2] : false,
      counts: { messages: counts.chatMessages, removedMessages: deletedMessages, roomBans: counts.roomBans },
      guests: guests.map((guest) => ({ ...guest, active: guest.status === StreamGuestStatus.ACTIVE })),
      moderators: moderators.map((moderator) => ({ ...moderator, active: moderator.status === ModeratorStatus.ACTIVE })),
    };
  }

  /** Newest first, every moderation status - the admin sees what viewers no longer do. */
  async chatLog(streamId: string, query: AdminChatLogQueryDto) {
    await this.assertExists(streamId);
    const q = query.q?.trim();
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        streamId,
        ...(query.status ? { moderationStatus: query.status } : {}),
        ...(q ? { text: { contains: q, mode: 'insensitive' } } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        text: true,
        imageUrl: true,
        moderationStatus: true,
        flaggedReason: true,
        createdAt: true,
        user: PERSON_SELECT,
      },
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async deleteMessage(admin: AdminPrincipal, streamId: string, messageId: string) {
    const message = await this.prisma.chatMessage.findFirst({ where: { id: messageId, streamId }, select: { id: true } });
    if (!message) throw new NotFoundException('Message not found');
    await this.chat.deleteAsAdmin(messageId, admin.id);
    return { ok: true };
  }

  async lock(admin: AdminPrincipal, streamId: string, reason: string) {
    await this.streams.lock(streamId, admin.id, reason);
    return this.detail(streamId);
  }

  async unlock(admin: AdminPrincipal, streamId: string) {
    await this.streams.unlock(streamId, admin.id);
    return this.detail(streamId);
  }

  private async assertExists(streamId: string): Promise<void> {
    const stream = await this.prisma.stream.findUnique({ where: { id: streamId }, select: { id: true } });
    if (!stream) throw new NotFoundException('Stream not found');
  }
}
