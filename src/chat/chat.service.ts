import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChatModerationStatus, ModeratorCapability, Prisma } from '@prisma/client';
import {
  ChatMessageDeletedPayload,
  ChatMessagePinnedPayload,
  ChatMessageUnpinnedPayload,
  DomainEvents,
} from '../common/events/domain-events';
import { PermissionsService } from '../common/permissions/permissions.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimit, RateLimitService } from '../common/rate-limit/rate-limit.service';
import { RedisService } from '../common/redis/redis.service';
import { STORAGE_PROVIDER, StorageProvider } from '../common/storage/storage-provider.interface';
import { ModeratorsService } from '../moderators/moderators.service';
import { RoomChatMutesService } from '../room-chat-mutes/room-chat-mutes.service';
import { notBlockedEitherWayWith } from '../social/block-filters';
import { StreamsService } from '../streams/streams.service';
import { BannedPhrasesService } from './banned-phrases.service';
import { ChatImageType, chatImageKey, chatPreviewText, isChatImageKey } from './chat-images';
import { ChatTextError, cleanChatText } from './chat-text';
import { ChatHistoryQueryDto } from './dto/chat-history.dto';
import { hasDisallowedLink, parseLinkDomains } from './link-policy';
import {
  ChatMention,
  MentionLookup,
  mentionedUsernames,
  mentionLookup,
  resolveMentions,
} from './mentions';

/** Three messages at once, then one every 1.5 s, per person per live (plan §6.3). */
export const CHAT_RATE_LIMIT: RateLimit = { capacity: 3, refillMs: 1500 };

// How long a message resent after a lost answer still maps to the first one.
const RESEND_WINDOW_SECONDS = 120;

const MESSAGE_SELECT = {
  id: true,
  streamId: true,
  text: true,
  imageUrl: true,
  createdAt: true,
  user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
} satisfies Prisma.ChatMessageSelect;

type MessageRow = Prisma.ChatMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

/** What `chat:new`, the send answer and history carry - kept small (plan §7). */
export interface ChatMessageView {
  id: string;
  streamId: string;
  // With a photo, its caption - maybe empty.
  text: string;
  // The host's photo, or null for a plain message.
  imageUrl: string | null;
  createdAt: Date;
  // username: a reply starts with `@username`.
  sender: { id: string; username: string; displayName: string; avatarUrl: string | null };
  /** The accounts its `@username`s name, in order - a typed name that isn't anyone is plain text. */
  mentions: ChatMention[];
}

export type ChatSendError =
  | ChatTextError
  | 'CHAT_MUTED'
  | 'RATE_LIMITED'
  | 'MESSAGE_BLOCKED'
  | 'LINK_NOT_ALLOWED'
  | 'NOT_ALLOWED'
  | 'IMAGE_INVALID';

export type ChatSendResult =
  | { ok: true; message: ChatMessageView; resent: boolean }
  | { ok: false; error: ChatSendError; retryAfterMs?: number };

// NOT_ALLOWED is decided before the message is looked at, so it never says whether one exists.
export type ChatDeleteResult = { ok: true } | { ok: false; error: 'NOT_FOUND' | 'NOT_ALLOWED' };
export type ChatPinResult = { ok: true } | { ok: false; error: 'NOT_FOUND' | 'NOT_ALLOWED' };

/** Live chat: the send pipeline and history. See docs/features/chat.md. */
@Injectable()
export class ChatService {
  private readonly linkDomains: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly rateLimit: RateLimitService,
    private readonly streams: StreamsService,
    private readonly permissions: PermissionsService,
    private readonly moderators: ModeratorsService,
    private readonly bannedPhrases: BannedPhrasesService,
    private readonly events: EventEmitter2,
    private readonly roomChatMutes: RoomChatMutesService,
    config: ConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {
    this.linkDomains = parseLinkDomains(config.get<string>('CHAT_LINK_DOMAINS'));
  }

  /**
   * The send pipeline (plan §6.3), in order: clean the text, the room chat
   * mute (plan §6.7), the word/phrase filter, rate-limit the sender, the link
   * policy, persist (masked, if the phrase filter only flagged a
   * MASK-severity match). The caller checks the sender is in the live.
   * With [imageKey] (the host only), the text is the photo's caption and may
   * be empty.
   */
  async send(
    streamId: string,
    userId: string,
    rawText: string,
    clientId?: string,
    imageKey?: string,
  ): Promise<ChatSendResult> {
    const cleaned = cleanChatText(rawText);
    if ('error' in cleaned && !(imageKey && cleaned.error === 'MESSAGE_EMPTY')) {
      return { ok: false, error: cleaned.error };
    }
    const cleanText = 'error' in cleaned ? '' : cleaned.text;

    let imageUrl: string | null = null;
    if (imageKey) {
      const live = await this.streams.findLive(streamId);
      if (!live || !this.permissions.isHost(userId, live.hostId))
        return { ok: false, error: 'NOT_ALLOWED' };
      if (!isChatImageKey(imageKey, streamId)) return { ok: false, error: 'IMAGE_INVALID' };
      imageUrl = this.storage.publicUrl(imageKey);
    }

    const resendKey = clientId ? `chat:sent:${userId}:${clientId}` : undefined;
    if (resendKey) {
      const earlier = await this.findSent(resendKey);
      if (earlier) return { ok: true, message: earlier, resent: true };
    }

    // For a timed mute, retryAfterMs says when it lifts; none means until the live ends.
    const mute = await this.roomChatMutes.findActive(streamId, userId);
    if (mute) {
      return mute.expiresAt
        ? {
            ok: false,
            error: 'CHAT_MUTED',
            retryAfterMs: Math.max(1, mute.expiresAt.getTime() - Date.now()),
          }
        : { ok: false, error: 'CHAT_MUTED' };
    }

    const phraseMatches = cleanText ? await this.bannedPhrases.match(cleanText) : [];
    if (phraseMatches.some((match) => match.severity === 'REJECT')) {
      return { ok: false, error: 'MESSAGE_BLOCKED' };
    }

    const retryAfterMs = await this.rateLimit.take(
      `ratelimit:chat:${streamId}:${userId}`,
      CHAT_RATE_LIMIT,
    );
    if (retryAfterMs > 0) return { ok: false, error: 'RATE_LIMITED', retryAfterMs };

    if (hasDisallowedLink(cleanText, this.linkDomains))
      return { ok: false, error: 'LINK_NOT_ALLOWED' };

    const text = phraseMatches.length > 0 ? await this.bannedPhrases.mask(cleanText) : cleanText;
    const row = await this.prisma.chatMessage.create({
      data: { streamId, userId, text, ...(imageUrl && { imageUrl }) },
      select: MESSAGE_SELECT,
    });
    if (resendKey) {
      await this.redis.getClient().set(resendKey, row.id, 'EX', RESEND_WINDOW_SECONDS);
    }
    return {
      ok: true,
      message: toView(row, await this.mentionLookupFor([row.text])),
      resent: false,
    };
  }

  /**
   * A presigned upload for a photo the host is about to post; the app sends
   * the returned `imageKey` with the message. Only for the live's host.
   */
  async createImageUploadUrl(streamId: string, userId: string, contentType: ChatImageType) {
    const live = await this.streams.findLive(streamId);
    if (!live) throw new NotFoundException('Stream is not live');
    if (!this.permissions.isHost(userId, live.hostId))
      throw new ForbiddenException('Only the host can post photos');
    const imageKey = chatImageKey(streamId, contentType);
    return { ...(await this.storage.createUploadUrl(imageKey, contentType)), imageKey };
  }

  /**
   * A live's visible messages, oldest first - see ChatHistoryQueryDto. For
   * [requesterId], without anyone blocked either way (plan §6.4).
   */
  async history(streamId: string, query: ChatHistoryQueryDto, requesterId?: string) {
    // Chat belongs to the live, not a public archive (plan §6.1).
    if (!(await this.streams.findLive(streamId))) {
      throw new NotFoundException('Stream is not live');
    }
    const rows = await this.prisma.chatMessage.findMany({
      // Prisma skips the bounds left undefined.
      where: {
        streamId,
        moderationStatus: ChatModerationStatus.VISIBLE,
        id: { lt: query.before, gt: query.after },
        ...(requesterId && { user: notBlockedEitherWayWith(requesterId) }),
      },
      // Newest first to pick the window; handed out oldest first.
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: MESSAGE_SELECT,
    });
    const page = rows.slice(0, query.limit).reverse();
    const lookup = await this.mentionLookupFor(page.map((row) => row.text));
    return {
      messages: page.map((row) => toView(row, lookup)),
      // Older messages exist - or, with `after`, more arrived than fit: a gap.
      hasEarlier: rows.length > query.limit,
    };
  }

  // One lookup for every name in [texts], none at all when nobody is mentioned.
  private async mentionLookupFor(texts: string[]): Promise<MentionLookup> {
    const names = [...new Set(texts.flatMap(mentionedUsernames).map((name) => name.toLowerCase()))];
    if (names.length === 0) return () => undefined;
    const accounts = await this.prisma.user.findMany({
      where: { username: { in: names, mode: 'insensitive' } },
      select: { id: true, username: true },
    });
    return mentionLookup(accounts);
  }

  private async findSent(resendKey: string): Promise<ChatMessageView | null> {
    const id = await this.redis.getClient().get(resendKey);
    if (!id) return null;
    const row = await this.prisma.chatMessage.findUnique({
      where: { id },
      select: MESSAGE_SELECT,
    });
    return row && toView(row, await this.mentionLookupFor([row.text]));
  }

  /**
   * Chat is moderated, not edited by its senders (plan §6.9): the host
   * deletes any message; an active moderator holding `DELETE_MESSAGES` any
   * but the host's and other moderators'.
   */
  async delete(
    streamId: string,
    messageId: string,
    requesterId: string,
  ): Promise<ChatDeleteResult> {
    const stream = await this.streams.findLive(streamId);
    if (!stream) return { ok: false, error: 'NOT_FOUND' };
    if (
      !(await this.canUseCapability(
        requesterId,
        streamId,
        stream.hostId,
        ModeratorCapability.DELETE_MESSAGES,
      ))
    ) {
      return { ok: false, error: 'NOT_ALLOWED' };
    }
    const visible = { id: messageId, streamId, moderationStatus: ChatModerationStatus.VISIBLE };
    if (!this.permissions.isHost(requesterId, stream.hostId)) {
      const message = await this.prisma.chatMessage.findFirst({
        where: visible,
        select: { userId: true },
      });
      if (!message) return { ok: false, error: 'NOT_FOUND' };
      const senderIsModerator =
        message.userId !== requesterId &&
        (await this.moderators.isActiveModerator(streamId, message.userId));
      if (
        this.permissions.moderationTargetRefusal(
          requesterId,
          stream.hostId,
          message.userId,
          senderIsModerator,
        )
      ) {
        return { ok: false, error: 'NOT_ALLOWED' };
      }
    }
    const result = await this.prisma.chatMessage.updateMany({
      where: visible,
      data: { moderationStatus: ChatModerationStatus.DELETED },
    });
    if (result.count === 0) return { ok: false, error: 'NOT_FOUND' };
    // Audit attribution (plan §6.9): who actually deleted it, not "the host".
    this.events.emit(DomainEvents.ChatMessageDeleted, {
      streamId,
      messageId,
      actorId: requesterId,
    } satisfies ChatMessageDeletedPayload);
    return { ok: true };
  }

  /**
   * The admin console (plan §6.8): erases messages for good, photos included,
   * live or not - anyone still in the live sees them go. Says how many went.
   */
  async eraseAsAdmin(messageIds: string[], actorId: string): Promise<number> {
    const messages = await this.prisma.chatMessage.findMany({
      where: { id: { in: messageIds } },
      select: {
        id: true,
        streamId: true,
        text: true,
        imageUrl: true,
        userId: true,
        user: { select: { username: true } },
        stream: { select: { hostId: true, pinnedMessageId: true } },
      },
    });
    if (messages.length === 0) return 0;
    const { count } = await this.prisma.chatMessage.deleteMany({
      where: { id: { in: messages.map((message) => message.id) } },
    });
    void this.storage.deleteUrls(messages.flatMap((message) => message.imageUrl ?? []));
    for (const message of messages) {
      // The stream's pin cleared itself with the row; the room still shows it.
      if (message.stream.pinnedMessageId === message.id) {
        this.events.emit(DomainEvents.ChatMessageUnpinned, {
          streamId: message.streamId,
          actorId,
        } satisfies ChatMessageUnpinnedPayload);
      }
      this.events.emit(DomainEvents.ChatMessageDeleted, {
        streamId: message.streamId,
        messageId: message.id,
        actorId,
        erased: {
          text: message.text,
          senderId: message.userId,
          sender: message.user.username,
          hostId: message.stream.hostId,
        },
      } satisfies ChatMessageDeletedPayload);
    }
    return count;
  }

  /** Pins one message to the top of chat - host, or an active moderator holding `PIN_MESSAGES` (plan §6.13). */
  async pin(streamId: string, messageId: string, requesterId: string): Promise<ChatPinResult> {
    const stream = await this.streams.findLive(streamId);
    if (!stream) return { ok: false, error: 'NOT_FOUND' };
    const canModerate = await this.canUseCapability(
      requesterId,
      streamId,
      stream.hostId,
      ModeratorCapability.PIN_MESSAGES,
    );
    if (!canModerate) return { ok: false, error: 'NOT_ALLOWED' };

    const message = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, streamId, moderationStatus: ChatModerationStatus.VISIBLE },
      select: { id: true, text: true, imageUrl: true, user: { select: { displayName: true } } },
    });
    if (!message) return { ok: false, error: 'NOT_FOUND' };

    await this.prisma.stream.update({
      where: { id: streamId },
      data: { pinnedMessageId: messageId },
    });
    this.events.emit(DomainEvents.ChatMessagePinned, {
      streamId,
      messageId,
      actorId: requesterId,
      text: chatPreviewText(message.text, message.imageUrl),
      senderName: message.user.displayName,
    } satisfies ChatMessagePinnedPayload);
    return { ok: true };
  }

  /** Unpins whatever's currently pinned, if anything - a no-op success either way. */
  async unpin(streamId: string, requesterId: string): Promise<ChatPinResult> {
    const stream = await this.streams.findLive(streamId);
    if (!stream) return { ok: false, error: 'NOT_FOUND' };
    const canModerate = await this.canUseCapability(
      requesterId,
      streamId,
      stream.hostId,
      ModeratorCapability.PIN_MESSAGES,
    );
    if (!canModerate) return { ok: false, error: 'NOT_ALLOWED' };

    await this.prisma.stream.update({ where: { id: streamId }, data: { pinnedMessageId: null } });
    this.events.emit(DomainEvents.ChatMessageUnpinned, {
      streamId,
      actorId: requesterId,
    } satisfies ChatMessageUnpinnedPayload);
    return { ok: true };
  }

  // Skips the grant lookup entirely for the host, who always passes. A
  // grant only ever applies to the one stream it was made for (plan §6.9).
  private async canUseCapability(
    requesterId: string,
    streamId: string,
    hostId: string,
    capability: ModeratorCapability,
  ): Promise<boolean> {
    if (this.permissions.isHost(requesterId, hostId)) return true;
    const grant = await this.moderators.findActiveGrant(streamId, requesterId);
    return this.permissions.hasChannelCapability(requesterId, hostId, grant, capability);
  }
}

function toView(row: MessageRow, mentions: MentionLookup): ChatMessageView {
  return {
    id: row.id,
    streamId: row.streamId,
    text: row.text,
    imageUrl: row.imageUrl,
    createdAt: row.createdAt,
    sender: row.user,
    mentions: resolveMentions(row.text, mentions),
  };
}
