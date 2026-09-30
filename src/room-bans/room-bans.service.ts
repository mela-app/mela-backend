import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RoomBanScope } from '@prisma/client';
import { DomainEvents, RoomBanCreatedPayload, RoomBanLiftedPayload } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';

/** Host room ban/kick (plan §6.4) - distinct from a personal Block. See docs/features/moderation.md. */
@Injectable()
export class RoomBansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async ban(hostId: string, bannedUserId: string, scope: RoomBanScope, streamId?: string, actorId?: string) {
    await this.prisma.roomBan.create({
      data: { hostId, bannedUserId, scope, streamId: scope === RoomBanScope.SESSION ? streamId : null },
    });
    this.events.emit(DomainEvents.RoomBanCreated, {
      hostId,
      bannedUserId,
      streamId: scope === RoomBanScope.SESSION ? (streamId ?? null) : null,
      scope,
      actorId: actorId ?? hostId,
    } satisfies RoomBanCreatedPayload);
    return { ok: true };
  }

  /** Lifts every ban this host has issued this user - both a specific-stream one and any permanent one. */
  async unban(hostId: string, bannedUserId: string, streamId?: string, actorId?: string) {
    const { count } = await this.prisma.roomBan.deleteMany({
      where: {
        hostId,
        bannedUserId,
        OR: [{ scope: RoomBanScope.HOST_PERMANENT }, ...(streamId ? [{ streamId }] : [])],
      },
    });
    if (count > 0) {
      this.events.emit(DomainEvents.RoomBanLifted, {
        hostId,
        bannedUserId,
        streamId: streamId ?? null,
        actorId: actorId ?? hostId,
      } satisfies RoomBanLiftedPayload);
    }
    return { ok: true };
  }

  /** True if this host has ever permanently banned this user, or banned them from this one stream. */
  async isBanned(hostId: string, userId: string, streamId: string): Promise<boolean> {
    const ban = await this.prisma.roomBan.findFirst({
      where: {
        hostId,
        bannedUserId: userId,
        OR: [{ scope: RoomBanScope.HOST_PERMANENT }, { streamId }],
      },
      select: { id: true },
    });
    return ban !== null;
  }
}
