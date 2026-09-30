import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvents, RecordingPermissionChangedPayload } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';

const ALLOWED_USER_SELECT = { select: { id: true, username: true, displayName: true, avatarUrl: true } } as const;

/**
 * Who may record a live: the app keeps it out of screen recordings and
 * screenshots for everyone else. The host always may. Who may grant is
 * StreamsService's call. See docs/features/streams.md.
 */
@Injectable()
export class RecordingPermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async allow(streamId: string, userId: string, actorId: string): Promise<void> {
    await this.prisma.recordingPermission.upsert({
      where: { streamId_userId: { streamId, userId } },
      create: { streamId, userId },
      update: {},
    });
    this.emit(streamId, userId, actorId, true);
  }

  async disallow(streamId: string, userId: string, actorId: string): Promise<void> {
    const { count } = await this.prisma.recordingPermission.deleteMany({ where: { streamId, userId } });
    if (count > 0) this.emit(streamId, userId, actorId, false);
  }

  async isAllowed(streamId: string, userId: string): Promise<boolean> {
    return (await this.prisma.recordingPermission.count({ where: { streamId, userId } })) > 0;
  }

  /** Everyone allowed to record this live, newest first. */
  async list(streamId: string) {
    const rows = await this.prisma.recordingPermission.findMany({
      where: { streamId },
      orderBy: { createdAt: 'desc' },
      select: { user: ALLOWED_USER_SELECT },
    });
    return { items: rows.map((row) => row.user) };
  }

  private emit(streamId: string, userId: string, actorId: string, allowed: boolean): void {
    this.events.emit(DomainEvents.RecordingPermissionChanged, {
      streamId,
      userId,
      actorId,
      allowed,
    } satisfies RecordingPermissionChangedPayload);
  }
}
