import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma/prisma.service';
import { RecordingPermissionsService } from './recording-permissions.service';

describe('RecordingPermissionsService', () => {
  const prisma = {
    recordingPermission: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const events = { emit: jest.fn() };
  const service = () =>
    new RecordingPermissionsService(prisma as unknown as PrismaService, events as unknown as EventEmitter2);

  beforeEach(() => jest.clearAllMocks());

  it('allows once per viewer and live, and tells that viewer', async () => {
    await service().allow('s1', 'fan-1', 'host-1');

    expect(prisma.recordingPermission.upsert).toHaveBeenCalledWith({
      where: { streamId_userId: { streamId: 's1', userId: 'fan-1' } },
      create: { streamId: 's1', userId: 'fan-1' },
      update: {},
    });
    expect(events.emit).toHaveBeenCalledWith('recording_permission.changed', {
      streamId: 's1',
      userId: 'fan-1',
      actorId: 'host-1',
      allowed: true,
    });
  });

  it('takes it back - and says nothing when there was nothing to take back', async () => {
    prisma.recordingPermission.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await service().disallow('s1', 'fan-1', 'host-1');
    await service().disallow('s1', 'fan-1', 'host-1');

    expect(prisma.recordingPermission.deleteMany).toHaveBeenCalledWith({ where: { streamId: 's1', userId: 'fan-1' } });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('recording_permission.changed', expect.objectContaining({ allowed: false }));
  });

  it('answers whether a viewer may record, and lists who may', async () => {
    prisma.recordingPermission.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const fan = { id: 'fan-1', username: 'fan', displayName: 'Fan', avatarUrl: null };
    prisma.recordingPermission.findMany.mockResolvedValue([{ user: fan }]);

    await expect(service().isAllowed('s1', 'fan-1')).resolves.toBe(true);
    await expect(service().isAllowed('s1', 'other')).resolves.toBe(false);
    await expect(service().list('s1')).resolves.toEqual({ items: [fan] });
  });
});
