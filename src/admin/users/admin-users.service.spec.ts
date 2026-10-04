import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminPermission, PlatformRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService } from '../../auth/auth.service';
import { effectiveAdminPermissions } from '../../common/permissions/admin-permissions';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StreamsService } from '../../streams/streams.service';
import { AdminPrincipal } from '../admin.guard';
import { AdminUsersService } from './admin-users.service';

describe('AdminUsersService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    stream: { findFirst: jest.fn() },
  };
  const auth = { revokeAllSessions: jest.fn() };
  const streams = { lockLiveStreamsOfHost: jest.fn() };
  const events = { emit: jest.fn() };

  const service = () =>
    new AdminUsersService(
      prisma as unknown as PrismaService,
      auth as unknown as AuthService,
      streams as unknown as StreamsService,
      events as unknown as EventEmitter2,
    );

  function principal(
    platformRole: PlatformRole = PlatformRole.SUPER_ADMIN,
    granted: AdminPermission[] = [],
  ): AdminPrincipal {
    return {
      id: 'admin-1',
      username: 'admin',
      email: 'admin@example.com',
      displayName: 'Admin',
      avatarUrl: null,
      platformRole,
      permissions: effectiveAdminPermissions(platformRole, granted),
      passwordChangeRequired: false,
      sessionId: 'session-1',
    };
  }
  const moderator = principal(PlatformRole.PLATFORM_MODERATOR, [AdminPermission.MANAGE_USERS]);

  const target = (overrides: Record<string, unknown> = {}) => ({
    id: 'u1',
    platformRole: PlatformRole.USER,
    status: UserStatus.ACTIVE,
    ...overrides,
  });

  const detailRow = {
    id: 'u1',
    username: 'ana',
    _count: {
      streams: 0,
      followedBy: 0,
      following: 0,
      chatMessages: 0,
      sessions: 0,
      blockedBy: 0,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue(target());
    prisma.user.update.mockResolvedValue({});
    prisma.user.count.mockResolvedValue(1);
    prisma.stream.findFirst.mockResolvedValue(null);
    streams.lockLiveStreamsOfHost.mockResolvedValue(0);
  });

  describe('suspend', () => {
    it('suspends with the reason, announces it and locks any live they are running', async () => {
      streams.lockLiveStreamsOfHost.mockResolvedValue(1);

      const result = await service().suspend(moderator, 'u1', 'Spam links');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          status: UserStatus.SUSPENDED,
          suspendedAt: expect.any(Date),
          suspensionReason: 'Spam links',
        },
      });
      expect(events.emit).toHaveBeenCalledWith('user.suspended', {
        userId: 'u1',
        suspendedBy: 'admin-1',
        reason: 'Spam links',
      });
      expect(streams.lockLiveStreamsOfHost).toHaveBeenCalledWith(
        'u1',
        'admin-1',
        "The host's account was suspended",
      );
      expect(result).toEqual({ ok: true, lockedLives: 1 });
    });

    it("won't suspend your own account", async () => {
      prisma.user.findUnique.mockResolvedValue(
        target({ id: 'admin-1', platformRole: PlatformRole.SUPER_ADMIN }),
      );
      await expect(service().suspend(principal(), 'admin-1', 'Testing')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('leaves staff accounts to super admins', async () => {
      prisma.user.findUnique.mockResolvedValue(
        target({ platformRole: PlatformRole.PLATFORM_MODERATOR }),
      );
      await expect(service().suspend(moderator, 'u1', 'Abuse')).rejects.toThrow(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('always keeps one active super admin', async () => {
      prisma.user.findUnique.mockResolvedValue(target({ platformRole: PlatformRole.SUPER_ADMIN }));
      prisma.user.count.mockResolvedValue(0);

      await expect(service().suspend(principal(), 'u1', 'Left the company')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('says so when the account is already suspended', async () => {
      prisma.user.findUnique.mockResolvedValue(target({ status: UserStatus.SUSPENDED }));
      await expect(service().suspend(moderator, 'u1', 'Again')).rejects.toThrow(ConflictException);
    });
  });

  describe('reinstate', () => {
    it('reactivates a suspended account and clears the reason', async () => {
      prisma.user.findUnique.mockResolvedValue(target({ status: UserStatus.SUSPENDED }));

      await service().reinstate(moderator, 'u1');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { status: UserStatus.ACTIVE, suspendedAt: null, suspensionReason: null },
      });
      expect(events.emit).toHaveBeenCalledWith('user.reinstated', {
        userId: 'u1',
        reinstatedBy: 'admin-1',
      });
    });

    it('refuses an account that is not suspended', async () => {
      await expect(service().reinstate(moderator, 'u1')).rejects.toThrow(ConflictException);
    });
  });

  describe('changeRole', () => {
    it('records the old and the new role, and what a new moderator may do', async () => {
      await service().changeRole(principal(), 'u1', PlatformRole.PLATFORM_MODERATOR, [
        AdminPermission.MANAGE_USERS,
      ]);

      const granted = [AdminPermission.VIEW_USERS, AdminPermission.MANAGE_USERS];
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { platformRole: PlatformRole.PLATFORM_MODERATOR, adminPermissions: granted },
      });
      expect(events.emit).toHaveBeenCalledWith('user.role_changed', {
        userId: 'u1',
        actorId: 'admin-1',
        from: PlatformRole.USER,
        to: PlatformRole.PLATFORM_MODERATOR,
        permissions: granted,
      });
    });

    it('needs to know what a new platform moderator may do', async () => {
      await expect(
        service().changeRole(principal(), 'u1', PlatformRole.PLATFORM_MODERATOR),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('clears the permissions of anyone who stops being a platform moderator', async () => {
      prisma.user.findUnique.mockResolvedValue(
        target({ platformRole: PlatformRole.PLATFORM_MODERATOR }),
      );

      await service().changeRole(principal(), 'u1', PlatformRole.USER, [
        AdminPermission.VIEW_LIVES,
      ]);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { platformRole: PlatformRole.USER, adminPermissions: [] },
      });
      expect(events.emit).toHaveBeenCalledWith('user.role_changed', {
        userId: 'u1',
        actorId: 'admin-1',
        from: PlatformRole.PLATFORM_MODERATOR,
        to: PlatformRole.USER,
      });
    });

    it("won't change your own role or demote the last super admin", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(target({ id: 'admin-1' }));
      await expect(service().changeRole(principal(), 'admin-1', PlatformRole.USER)).rejects.toThrow(
        BadRequestException,
      );

      prisma.user.findUnique.mockResolvedValueOnce(
        target({ platformRole: PlatformRole.SUPER_ADMIN }),
      );
      prisma.user.count.mockResolvedValue(0);
      await expect(service().changeRole(principal(), 'u1', PlatformRole.USER)).rejects.toThrow(
        ConflictException,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('does nothing when the role is unchanged', async () => {
      await expect(service().changeRole(principal(), 'u1', PlatformRole.USER)).resolves.toEqual({
        ok: true,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('changePermissions', () => {
    const moderatorRow = (adminPermissions: AdminPermission[]) =>
      target({ platformRole: PlatformRole.PLATFORM_MODERATOR, adminPermissions });

    it('changes what a moderator may do and records before and after', async () => {
      prisma.user.findUnique.mockResolvedValue(moderatorRow([AdminPermission.VIEW_LIVES]));

      await expect(
        service().changePermissions(principal(), 'u1', [
          AdminPermission.MANAGE_LIVES,
          AdminPermission.VIEW_AUDIT_LOG,
        ]),
      ).resolves.toEqual({
        ok: true,
        permissions: [
          AdminPermission.VIEW_LIVES,
          AdminPermission.MANAGE_LIVES,
          AdminPermission.VIEW_AUDIT_LOG,
        ],
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          adminPermissions: [
            AdminPermission.VIEW_LIVES,
            AdminPermission.MANAGE_LIVES,
            AdminPermission.VIEW_AUDIT_LOG,
          ],
        },
      });
      expect(events.emit).toHaveBeenCalledWith('user.admin_permissions_changed', {
        userId: 'u1',
        actorId: 'admin-1',
        from: [AdminPermission.VIEW_LIVES],
        to: [
          AdminPermission.VIEW_LIVES,
          AdminPermission.MANAGE_LIVES,
          AdminPermission.VIEW_AUDIT_LOG,
        ],
      });
    });

    it('records nothing when the access is the same', async () => {
      prisma.user.findUnique.mockResolvedValue(
        moderatorRow([AdminPermission.VIEW_LIVES, AdminPermission.MANAGE_LIVES]),
      );

      await service().changePermissions(principal(), 'u1', [AdminPermission.MANAGE_LIVES]);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('only applies to platform moderators, who must keep some access', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(
        target({ platformRole: PlatformRole.SUPER_ADMIN }),
      );
      await expect(
        service().changePermissions(principal(), 'u1', [AdminPermission.VIEW_LIVES]),
      ).rejects.toThrow(BadRequestException);

      prisma.user.findUnique.mockResolvedValueOnce(moderatorRow([AdminPermission.VIEW_LIVES]));
      await expect(service().changePermissions(principal(), 'u1', [])).rejects.toThrow(
        BadRequestException,
      );

      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(
        service().changePermissions(principal(), 'u1', [AdminPermission.VIEW_LIVES]),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  it('signs a user out everywhere', async () => {
    auth.revokeAllSessions.mockResolvedValue(3);

    await expect(service().revokeSessions(moderator, 'u1')).resolves.toEqual({
      ok: true,
      revoked: 3,
    });
    expect(events.emit).toHaveBeenCalledWith('user.sessions_revoked', {
      userId: 'u1',
      actorId: 'admin-1',
    });
  });

  describe('createStaff', () => {
    it('creates the account with a one-time password it must replace', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'staff-1', ...data }),
      );

      const { user, temporaryPassword } = await service().createStaff(principal(), {
        email: 'Mia.Lee@example.com',
        displayName: 'Mia Lee',
        platformRole: PlatformRole.PLATFORM_MODERATOR,
        permissions: [AdminPermission.MANAGE_LIVES],
      });

      const granted = [AdminPermission.VIEW_LIVES, AdminPermission.MANAGE_LIVES];
      const { data } = prisma.user.create.mock.calls[0][0];
      expect(data).toEqual(
        expect.objectContaining({
          username: 'mialee',
          platformRole: PlatformRole.PLATFORM_MODERATOR,
          adminPermissions: granted,
          passwordChangeRequired: true,
        }),
      );
      expect(data.passwordHash).not.toBe(temporaryPassword);
      expect(await argon2.verify(data.passwordHash, temporaryPassword)).toBe(true);
      expect(user.permissions).toEqual(granted);
      expect(events.emit).toHaveBeenCalledWith('admin.staff_created', {
        userId: user.id,
        actorId: 'admin-1',
        role: PlatformRole.PLATFORM_MODERATOR,
        permissions: granted,
      });
    });

    it('needs to know what a new platform moderator may do', async () => {
      await expect(
        service().createStaff(principal(), {
          email: 'mia@example.com',
          displayName: 'Mia',
          platformRole: PlatformRole.PLATFORM_MODERATOR,
          permissions: [],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('gives a new super admin everything, storing nothing', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'staff-2', ...data }),
      );

      const { user } = await service().createStaff(principal(), {
        email: 'sam@example.com',
        displayName: 'Sam',
        platformRole: PlatformRole.SUPER_ADMIN,
        permissions: [AdminPermission.VIEW_LIVES],
      });

      expect(prisma.user.create.mock.calls[0][0].data.adminPermissions).toEqual([]);
      expect(user.permissions).toEqual(effectiveAdminPermissions(PlatformRole.SUPER_ADMIN, []));
    });

    it('points to the role change for an email that already has an account', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      await expect(
        service().createStaff(principal(), {
          email: 'ana@example.com',
          displayName: 'Ana',
          platformRole: PlatformRole.PLATFORM_MODERATOR,
          permissions: [AdminPermission.VIEW_USERS],
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('editProfile', () => {
    const profile = {
      id: 'u1',
      platformRole: PlatformRole.USER,
      username: 'bad_name',
      displayName: 'Bad Name',
      bio: 'Offensive bio',
      avatarUrl: 'http://localhost:9090/avatars/u1.jpg',
    };

    it('changes only what differs and keeps the old values for the audit trail', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(profile).mockResolvedValueOnce(detailRow);
      prisma.user.findFirst.mockResolvedValue(null);

      await service().editProfile(moderator, 'u1', {
        username: 'user_1',
        displayName: 'Bad Name',
        bio: '',
        removeAvatar: true,
        reason: 'Offensive profile',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { username: 'user_1', bio: null, avatarUrl: null },
      });
      expect(events.emit).toHaveBeenCalledWith('user.profile_moderated', {
        userId: 'u1',
        actorId: 'admin-1',
        reason: 'Offensive profile',
        changes: {
          username: { from: 'bad_name', to: 'user_1' },
          bio: { from: 'Offensive bio', to: null },
          avatar: { from: profile.avatarUrl, to: null },
        },
      });
    });

    it('refuses a username someone else has, in any letter case', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(profile);
      prisma.user.findFirst.mockResolvedValue({ id: 'u2' });

      await expect(
        service().editProfile(moderator, 'u1', { username: 'Taken', reason: 'Offensive name' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { username: { equals: 'Taken', mode: 'insensitive' }, id: { not: 'u1' } },
        select: { id: true },
      });
    });

    it('says when there is nothing to change', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(profile);

      await expect(
        service().editProfile(moderator, 'u1', { displayName: 'Bad Name', reason: 'No-op' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('leaves staff profiles to super admins', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        ...profile,
        platformRole: PlatformRole.SUPER_ADMIN,
      });

      await expect(
        service().editProfile(moderator, 'u1', { displayName: 'X', reason: 'Because' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
