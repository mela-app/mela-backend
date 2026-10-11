import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StreamEndReason, StreamStatus } from '@prisma/client';
import { PermissionsService } from '../common/permissions/permissions.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageProvider } from '../common/storage/storage-provider.interface';
import { StreamThumbnailsService, isThumbnailKey, thumbnailKey } from './stream-thumbnails.service';

const LIVE = '3f1c9a52-7c2e-4a8b-9d7e-2b6f0c1d4e5a';
const OTHER = '9b2f0c1d-4e5a-4a8b-9d7e-2b6f0c1d4e5a';

describe('StreamThumbnailsService', () => {
  const prisma = { stream: { findUnique: jest.fn(), updateMany: jest.fn() } };
  const storage = {
    createUploadUrl: jest.fn(async (key: string) => ({
      uploadUrl: `https://bucket.example.com/${key}?signed`,
      publicUrl: `https://media.example.com/${key}`,
    })),
    publicUrl: jest.fn((key: string) => `https://media.example.com/${key}`),
    deleteUrls: jest.fn().mockResolvedValue(undefined),
  };
  const service = () =>
    new StreamThumbnailsService(
      prisma as unknown as PrismaService,
      new PermissionsService(),
      storage as unknown as StorageProvider,
    );
  const live = (thumbnailUrl: string | null = null) => ({
    hostId: 'host-1',
    status: StreamStatus.LIVE,
    thumbnailUrl,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.stream.updateMany.mockResolvedValue({ count: 1 });
  });

  it("hands out keys only this live's own frames pass", () => {
    const key = thumbnailKey(LIVE);
    expect(isThumbnailKey(key, LIVE)).toBe(true);
    expect(isThumbnailKey(key, OTHER)).toBe(false);
    expect(isThumbnailKey(`thumbnails/${LIVE}/../avatars/x.jpg`, LIVE)).toBe(false);
    expect(isThumbnailKey(`chat-images/${LIVE}/${key.split('/').pop()}`, LIVE)).toBe(false);
  });

  it('gives the host a presigned JPEG upload for the next frame', async () => {
    prisma.stream.findUnique.mockResolvedValue(live());

    const result = await service().uploadUrl(LIVE, 'host-1');

    expect(isThumbnailKey(result.thumbnailKey, LIVE)).toBe(true);
    expect(storage.createUploadUrl).toHaveBeenCalledWith(result.thumbnailKey, 'image/jpeg');
  });

  it('only the host, and only while live', async () => {
    prisma.stream.findUnique.mockResolvedValue(live());
    await expect(service().uploadUrl(LIVE, 'viewer-1')).rejects.toThrow(ForbiddenException);

    prisma.stream.findUnique.mockResolvedValue({ ...live(), status: StreamStatus.ENDED });
    await expect(service().uploadUrl(LIVE, 'host-1')).rejects.toThrow(NotFoundException);
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
  });

  it("shows the new frame and deletes the previous one's file", async () => {
    prisma.stream.findUnique.mockResolvedValue(live('https://media.example.com/old.jpg'));
    const key = thumbnailKey(LIVE);

    await expect(service().set(LIVE, 'host-1', key)).resolves.toEqual({
      thumbnailUrl: `https://media.example.com/${key}`,
    });

    expect(prisma.stream.updateMany).toHaveBeenCalledWith({
      where: { id: LIVE, status: StreamStatus.LIVE },
      data: { thumbnailUrl: `https://media.example.com/${key}` },
    });
    expect(storage.deleteUrls).toHaveBeenCalledWith(['https://media.example.com/old.jpg']);
  });

  it("refuses a key that isn't this live's frame", async () => {
    prisma.stream.findUnique.mockResolvedValue(live());

    await expect(service().set(LIVE, 'host-1', thumbnailKey(OTHER))).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.stream.updateMany).not.toHaveBeenCalled();
  });

  it('a live that ended meanwhile keeps no frame - the uploaded file goes', async () => {
    prisma.stream.findUnique.mockResolvedValue(live());
    prisma.stream.updateMany.mockResolvedValue({ count: 0 });
    const key = thumbnailKey(LIVE);

    await expect(service().set(LIVE, 'host-1', key)).rejects.toThrow(NotFoundException);
    expect(storage.deleteUrls).toHaveBeenCalledWith([`https://media.example.com/${key}`]);
  });

  it('removes the last frame, and its file, when the live ends', async () => {
    prisma.stream.findUnique.mockResolvedValue({ thumbnailUrl: 'https://media.example.com/a.jpg' });

    await service().onStreamEnded({ streamId: LIVE, reason: StreamEndReason.HOST_ENDED });

    expect(prisma.stream.updateMany).toHaveBeenCalledWith({
      where: { id: LIVE, thumbnailUrl: 'https://media.example.com/a.jpg' },
      data: { thumbnailUrl: null },
    });
    expect(storage.deleteUrls).toHaveBeenCalledWith(['https://media.example.com/a.jpg']);
  });

  it('nothing to remove for a live that never sent one', async () => {
    prisma.stream.findUnique.mockResolvedValue({ thumbnailUrl: null });

    await service().onStreamEnded({ streamId: LIVE, reason: StreamEndReason.HOST_ENDED });

    expect(storage.deleteUrls).not.toHaveBeenCalled();
  });
});
