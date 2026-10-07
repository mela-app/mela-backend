import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlatformRole, StreamStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { IdentityVerifier } from '../auth/identity/firebase-identity.verifier';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageProvider } from '../common/storage/storage-provider.interface';
import { StreamsService } from '../streams/streams.service';
import { AccountDeletionService } from './account-deletion.service';

describe('AccountDeletionService', () => {
  const prisma = {
    user: { findUnique: jest.fn(), delete: jest.fn() },
    stream: { findMany: jest.fn(), deleteMany: jest.fn() },
    chatMessage: { findMany: jest.fn() },
    auditLog: { updateMany: jest.fn() },
    $transaction: jest.fn((steps: Promise<unknown>[]) => Promise.all(steps)),
  };
  const verifier = { verify: jest.fn() };
  const streams = { end: jest.fn() };
  const events = { emit: jest.fn() };
  const storage = { deleteUrls: jest.fn().mockResolvedValue(undefined) };
  let hash: string;

  const service = () =>
    new AccountDeletionService(
      prisma as unknown as PrismaService,
      verifier as unknown as IdentityVerifier,
      streams as unknown as StreamsService,
      events as unknown as EventEmitter2,
      storage as unknown as StorageProvider,
    );

  beforeAll(async () => {
    hash = await argon2.hash('my password 1');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockImplementation(({ select }: { select: Record<string, unknown> }) =>
      Promise.resolve(
        'avatarUrl' in select
          ? { avatarUrl: 'https://media.example/avatars/u1/a.jpg' }
          : { passwordHash: hash, platformRole: PlatformRole.USER, identities: [] },
      ),
    );
    prisma.stream.findMany.mockResolvedValue([]);
    prisma.chatMessage.findMany.mockResolvedValue([]);
  });

  it('deletes the account and all it made once the password proves it, keeping anonymous records', async () => {
    prisma.stream.findMany.mockResolvedValue([{ id: 'live-1' }]);
    prisma.chatMessage.findMany.mockResolvedValue([
      { imageUrl: 'https://media.example/chat-images/live-1/p.jpg' },
    ]);
    streams.end.mockResolvedValue({});

    await expect(service().deleteOwn('u1', { currentPassword: 'my password 1' })).resolves.toEqual({
      ok: true,
    });

    expect(prisma.stream.findMany).toHaveBeenCalledWith({
      where: { hostId: 'u1', status: StreamStatus.LIVE },
      select: { id: true },
    });
    expect(streams.end).toHaveBeenCalledWith('live-1', 'u1');
    expect(prisma.auditLog.updateMany).toHaveBeenCalledWith({
      where: { actorId: 'u1' },
      data: { actorLabel: 'Deleted account', ip: null, userAgent: null },
    });
    expect(prisma.auditLog.updateMany).toHaveBeenCalledWith({
      where: { targetType: 'USER', targetId: 'u1' },
      data: { targetLabel: 'Deleted account' },
    });
    expect(prisma.stream.deleteMany).toHaveBeenCalledWith({ where: { hostId: 'u1' } });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
    expect(storage.deleteUrls).toHaveBeenCalledWith([
      'https://media.example/avatars/u1/a.jpg',
      'https://media.example/chat-images/live-1/p.jpg',
    ]);
    expect(events.emit).toHaveBeenCalledWith(DomainEvents.AccountDeleted, {
      userId: 'u1',
      actorId: null,
      reason: null,
    });
  });

  it('deletes nothing without the right password', async () => {
    await expect(service().deleteOwn('u1', { currentPassword: 'wrong one 1' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service().deleteOwn('u1', {})).rejects.toThrow(BadRequestException);
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('confirms an account made with Google with its own Google account', async () => {
    prisma.user.findUnique.mockImplementation(({ select }: { select: Record<string, unknown> }) =>
      Promise.resolve(
        'avatarUrl' in select
          ? { avatarUrl: null }
          : {
              passwordHash: null,
              platformRole: PlatformRole.USER,
              identities: [{ subject: 'g-1' }],
            },
      ),
    );
    verifier.verify.mockResolvedValue({
      method: 'google',
      subject: 'g-1',
      email: 'a@gmail.com',
      name: 'A',
    });

    await service().deleteOwn('u1', { idToken: 'google-token' });

    expect(verifier.verify).toHaveBeenCalledWith('google-token');
    expect(prisma.user.delete).toHaveBeenCalled();
    expect(storage.deleteUrls).not.toHaveBeenCalled();
  });

  it('leaves staff accounts to the console', async () => {
    prisma.user.findUnique.mockResolvedValue({
      passwordHash: hash,
      platformRole: PlatformRole.PLATFORM_MODERATOR,
      identities: [],
    });

    await expect(service().deleteOwn('u1', { currentPassword: 'my password 1' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('lets a super admin delete an app account for someone who asked, with a reason', async () => {
    prisma.user.findUnique.mockImplementation(({ select }: { select: Record<string, unknown> }) =>
      Promise.resolve(
        'avatarUrl' in select ? { avatarUrl: null } : { platformRole: PlatformRole.USER },
      ),
    );

    await service().deleteByStaff('admin-1', 'u1', 'Asked by email');

    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
    expect(events.emit).toHaveBeenCalledWith(DomainEvents.AccountDeleted, {
      userId: 'u1',
      actorId: 'admin-1',
      reason: 'Asked by email',
    });
  });

  it('never deletes the admin themselves, or a staff account', async () => {
    await expect(service().deleteByStaff('admin-1', 'admin-1', 'Test')).rejects.toThrow(
      BadRequestException,
    );
    prisma.user.findUnique.mockResolvedValue({ platformRole: PlatformRole.SUPER_ADMIN });
    await expect(service().deleteByStaff('admin-1', 'u2', 'Test')).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});
