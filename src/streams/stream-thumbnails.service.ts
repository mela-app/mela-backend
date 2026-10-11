import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { StreamStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DomainEvents, StreamEndedPayload } from '../common/events/domain-events';
import { PermissionsService } from '../common/permissions/permissions.service';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  STORAGE_PROVIDER,
  StorageProvider,
  UploadUrl,
} from '../common/storage/storage-provider.interface';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Where a new frame of this live is stored - one fresh key per upload, so caches never serve an old one. */
export function thumbnailKey(streamId: string): string {
  return `thumbnails/${streamId}/${randomUUID()}.jpg`;
}

/** Only keys this API handed out for this live: a live can't take another's frame, or any other object. */
export function isThumbnailKey(key: string, streamId: string): boolean {
  const prefix = `thumbnails/${streamId}/`;
  return key.startsWith(prefix) && new RegExp(`^${UUID}\\.jpg$`).test(key.slice(prefix.length));
}

/**
 * A recent frame of each running live - the discovery cards and the share
 * link's preview show it instead of category art. The host's app takes one
 * shortly after going live and then every minute or so, uploads it straight
 * to storage (a presigned PUT, like avatars and chat photos), then names it
 * here; the previous frame's file is deleted. The last one goes when the
 * live ends. See docs/features/streams.md.
 */
@Injectable()
export class StreamThumbnailsService {
  private readonly logger = new Logger(StreamThumbnailsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /** A presigned upload for the next frame (JPEG); `PUT /streams/:id/thumbnail` names it after. */
  async uploadUrl(
    streamId: string,
    requesterId: string,
  ): Promise<UploadUrl & { thumbnailKey: string }> {
    await this.hostLiveOrThrow(streamId, requesterId);
    const key = thumbnailKey(streamId);
    return { ...(await this.storage.createUploadUrl(key, 'image/jpeg')), thumbnailKey: key };
  }

  async set(streamId: string, requesterId: string, key: string): Promise<{ thumbnailUrl: string }> {
    const stream = await this.hostLiveOrThrow(streamId, requesterId);
    if (!isThumbnailKey(key, streamId)) {
      throw new BadRequestException('That picture is not from this live');
    }
    const thumbnailUrl = this.storage.publicUrl(key);
    // Conditional, so a live that ended meanwhile isn't given a frame it would keep.
    const { count } = await this.prisma.stream.updateMany({
      where: { id: streamId, status: StreamStatus.LIVE },
      data: { thumbnailUrl },
    });
    if (count === 0) {
      void this.storage.deleteUrls([thumbnailUrl]);
      throw new NotFoundException('Stream is not live');
    }
    if (stream.thumbnailUrl && stream.thumbnailUrl !== thumbnailUrl) {
      void this.storage.deleteUrls([stream.thumbnailUrl]);
    }
    return { thumbnailUrl };
  }

  // Only a running live shows one; its file goes with it.
  @OnEvent(DomainEvents.StreamEnded)
  async onStreamEnded(payload: StreamEndedPayload): Promise<void> {
    try {
      const stream = await this.prisma.stream.findUnique({
        where: { id: payload.streamId },
        select: { thumbnailUrl: true },
      });
      if (!stream?.thumbnailUrl) return;
      await this.prisma.stream.updateMany({
        where: { id: payload.streamId, thumbnailUrl: stream.thumbnailUrl },
        data: { thumbnailUrl: null },
      });
      await this.storage.deleteUrls([stream.thumbnailUrl]);
    } catch (error) {
      this.logger.warn(`Could not remove the frame of ${payload.streamId}: ${error}`);
    }
  }

  private async hostLiveOrThrow(streamId: string, requesterId: string) {
    const stream = await this.prisma.stream.findUnique({
      where: { id: streamId },
      select: { hostId: true, status: true, thumbnailUrl: true },
    });
    if (!stream || stream.status !== StreamStatus.LIVE) {
      throw new NotFoundException('Stream is not live');
    }
    if (!this.permissions.canEditStreamDetails(requesterId, stream.hostId)) {
      throw new ForbiddenException('Only the host can set the live picture');
    }
    return stream;
  }
}
