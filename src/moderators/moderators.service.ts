import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ModeratorCapability, ModeratorStatus } from '@prisma/client';
import {
  DomainEvents,
  ModeratorGrantedPayload,
  ModeratorRevokedPayload,
  ModeratorUpdatedPayload,
} from '../common/events/domain-events';
import { ModeratorGrant } from '../common/permissions/permissions.service';
import { PrismaService } from '../common/prisma/prisma.service';

const PROFILE_SUMMARY_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

/**
 * Host-delegated moderators, scoped to the one stream a grant was made for
 * (plan §6.9, revised 2026-09-26) - a grant never carries over to the
 * host's future streams. See docs/features/moderators.md.
 */
@Injectable()
export class ModeratorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /** Null when there's no active grant - the cheap, indexed lookup every moderation check starts from. */
  async findActiveGrant(streamId: string, userId: string): Promise<ModeratorGrant | null> {
    const row = await this.prisma.moderator.findUnique({
      where: { streamId_userId: { streamId, userId } },
      select: { capabilities: true, status: true },
    });
    return row && row.status === ModeratorStatus.ACTIVE ? { capabilities: row.capabilities } : null;
  }

  async isActiveModerator(streamId: string, userId: string): Promise<boolean> {
    return (await this.findActiveGrant(streamId, userId)) !== null;
  }

  /** Who moderates this stream right now - public to everyone in it, unlike what each may do. */
  async listActiveUserIds(streamId: string): Promise<string[]> {
    const rows = await this.prisma.moderator.findMany({
      where: { streamId, status: ModeratorStatus.ACTIVE },
      orderBy: { grantedAt: 'asc' },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  /** Every active moderator for this one stream - not the host's whole channel history. */
  async list(streamId: string) {
    const rows = await this.prisma.moderator.findMany({
      where: { streamId, status: ModeratorStatus.ACTIVE },
      orderBy: { grantedAt: 'desc' },
      select: { capabilities: true, grantedAt: true, user: { select: PROFILE_SUMMARY_SELECT } },
    });
    // Wrapped, like every other list endpoint in the app (plan §7) - a bare
    // JSON array at the top level doesn't fit the client's Map<String, dynamic> convention.
    return {
      items: rows.map((row) => ({
        user: row.user,
        capabilities: row.capabilities,
        grantedAt: row.grantedAt,
      })),
    };
  }

  /** Every active moderator's userId holding `capability` for this stream - for a realtime fan-out list, not display. */
  async listUserIdsWithCapability(
    streamId: string,
    capability: ModeratorCapability,
  ): Promise<string[]> {
    const rows = await this.prisma.moderator.findMany({
      where: { streamId, status: ModeratorStatus.ACTIVE, capabilities: { has: capability } },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  /**
   * Grants or reactivates with a fresh set of capabilities, scoped to this
   * one stream - idempotent, like follow/unfollow. The caller
   * (`StreamsService`) has already confirmed the requester is the host of
   * this specific, currently-live stream before calling this.
   */
  async grant(
    hostId: string,
    streamId: string,
    userId: string,
    capabilities: ModeratorCapability[],
  ) {
    if (hostId === userId) throw new BadRequestException("You can't moderate your own stream");
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found');

    await this.prisma.moderator.upsert({
      where: { streamId_userId: { streamId, userId } },
      create: { hostId, streamId, userId, capabilities },
      update: { capabilities, status: ModeratorStatus.ACTIVE, revokedAt: null },
    });
    this.events.emit(DomainEvents.ModeratorGranted, {
      hostId,
      streamId,
      userId,
      capabilities,
    } satisfies ModeratorGrantedPayload);
    return { ok: true };
  }

  /** Changes an existing active moderator's capabilities for this stream - 404s if they aren't currently one. */
  async updateCapabilities(streamId: string, userId: string, capabilities: ModeratorCapability[]) {
    const result = await this.prisma.moderator.updateMany({
      where: { streamId, userId, status: ModeratorStatus.ACTIVE },
      data: { capabilities },
    });
    if (result.count === 0) throw new NotFoundException('Not an active moderator for this stream');
    this.events.emit(DomainEvents.ModeratorUpdated, {
      streamId,
      userId,
      capabilities,
    } satisfies ModeratorUpdatedPayload);
    return { ok: true };
  }

  /** Idempotent - revoking someone who isn't (or is no longer) an active moderator for this stream just succeeds. */
  async revoke(streamId: string, userId: string) {
    const result = await this.prisma.moderator.updateMany({
      where: { streamId, userId, status: ModeratorStatus.ACTIVE },
      data: { status: ModeratorStatus.REVOKED, revokedAt: new Date() },
    });
    if (result.count > 0) {
      this.events.emit(DomainEvents.ModeratorRevoked, {
        streamId,
        userId,
      } satisfies ModeratorRevokedPayload);
    }
    return { ok: true };
  }
}
