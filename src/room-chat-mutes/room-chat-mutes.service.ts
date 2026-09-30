import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvents, RoomChatMuteChangedPayload } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';

const MUTED_USER_SELECT = { select: { id: true, username: true, displayName: true, avatarUrl: true } } as const;

/**
 * Room chat mute (plan §6.7): stops one user's messages being accepted in
 * one live, for a while or until it ends. Who may mute is StreamsService's
 * call; enforcement is ChatService.send. See docs/features/moderation.md.
 */
@Injectable()
export class RoomChatMutesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /** Muting someone already muted replaces the expiry - `expiresAt` null means until the live ends. */
  async mute(streamId: string, userId: string, actorId: string, expiresAt: Date | null): Promise<void> {
    await this.prisma.roomChatMute.upsert({
      where: { streamId_userId: { streamId, userId } },
      create: { streamId, userId, mutedById: actorId, expiresAt },
      update: { mutedById: actorId, expiresAt, createdAt: new Date() },
    });
    this.events.emit(DomainEvents.RoomChatMuteChanged, {
      streamId,
      userId,
      actorId,
      muted: true,
      mutedUntil: expiresAt,
    } satisfies RoomChatMuteChangedPayload);
  }

  async unmute(streamId: string, userId: string, actorId: string): Promise<void> {
    const { count } = await this.prisma.roomChatMute.deleteMany({ where: { streamId, userId } });
    // No row, nothing to lift. A row that already ran out still announces:
    // the client may have missed the expiry while backgrounded.
    if (count === 0) return;
    this.events.emit(DomainEvents.RoomChatMuteChanged, {
      streamId,
      userId,
      actorId,
      muted: false,
      mutedUntil: null,
    } satisfies RoomChatMuteChangedPayload);
  }

  /** The user's mute in this live if it's still running, else null. `expiresAt` null: until the live ends. */
  findActive(streamId: string, userId: string): Promise<{ expiresAt: Date | null } | null> {
    return this.prisma.roomChatMute.findFirst({
      where: { streamId, userId, ...this.stillRunning() },
      select: { expiresAt: true },
    });
  }

  /** Everyone muted in this live right now, newest first - the host/moderator list. */
  async listActive(streamId: string) {
    const rows = await this.prisma.roomChatMute.findMany({
      where: { streamId, ...this.stillRunning() },
      orderBy: { createdAt: 'desc' },
      select: { expiresAt: true, user: MUTED_USER_SELECT },
    });
    return { items: rows.map((row) => ({ ...row.user, mutedUntil: row.expiresAt })) };
  }

  // Expired rows stay until the next mute replaces them or the stream's rows
  // cascade away - every read filters them out instead of a cleanup job.
  private stillRunning() {
    return { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
  }
}
