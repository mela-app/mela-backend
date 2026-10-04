import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AdminPermission, PlatformRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  AdminGuard,
  AllowPendingPasswordChange,
  RequirePermission,
  SuperAdminOnly,
} from './admin.guard';

class Routes {
  plain() {}

  @SuperAdminOnly()
  superAdminOnly() {}

  @AllowPendingPasswordChange()
  changePassword() {}

  @RequirePermission(AdminPermission.VIEW_USERS)
  readUsers() {}

  @RequirePermission(AdminPermission.MANAGE_USERS)
  editUser() {}
}

describe('AdminGuard', () => {
  const jwt = { verifyAsync: jest.fn() };
  const config = { get: jest.fn(() => 'secret') };
  const prisma = { userSession: { findFirst: jest.fn() } };

  const guard = () =>
    new AdminGuard(
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      prisma as unknown as PrismaService,
      new Reflector(),
    );

  function staff(overrides: Record<string, unknown> = {}) {
    return {
      id: 'admin-1',
      username: 'admin',
      email: 'admin@example.com',
      displayName: 'Admin',
      avatarUrl: null,
      platformRole: PlatformRole.PLATFORM_MODERATOR,
      adminPermissions: [],
      status: UserStatus.ACTIVE,
      passwordChangeRequired: false,
      ...overrides,
    };
  }

  function contextFor(handler: keyof Routes, authorization: string | null = 'Bearer token') {
    const request: Record<string, unknown> = { headers: authorization ? { authorization } : {} };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => Routes.prototype[handler],
      getClass: () => Routes,
    } as unknown as ExecutionContext;
    return { context, request };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verifyAsync.mockResolvedValue({ sub: 'admin-1', sid: 'session-1', username: 'admin' });
    prisma.userSession.findFirst.mockResolvedValue({ user: staff() });
  });

  it('lets an active staff member in and attaches them, re-read from the database', async () => {
    const { context, request } = contextFor('plain');

    await expect(guard().canActivate(context)).resolves.toBe(true);

    expect(prisma.userSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'session-1', userId: 'admin-1' } }),
    );
    expect(request.admin).toEqual(
      expect.objectContaining({
        id: 'admin-1',
        platformRole: PlatformRole.PLATFORM_MODERATOR,
        sessionId: 'session-1',
      }),
    );
  });

  it('needs a bearer token', async () => {
    await expect(guard().canActivate(contextFor('plain', null).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses an expired or forged token', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    await expect(guard().canActivate(contextFor('plain').context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a token whose session was signed out or revoked', async () => {
    prisma.userSession.findFirst.mockResolvedValue(null);
    await expect(guard().canActivate(contextFor('plain').context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a suspended staff member at once', async () => {
    prisma.userSession.findFirst.mockResolvedValue({
      user: staff({ status: UserStatus.SUSPENDED }),
    });
    await expect(guard().canActivate(contextFor('plain').context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a regular app user, whatever the token says', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'admin-1',
      sid: 'session-1',
      platformRole: PlatformRole.SUPER_ADMIN,
    });
    prisma.userSession.findFirst.mockResolvedValue({
      user: staff({ platformRole: PlatformRole.USER }),
    });
    await expect(guard().canActivate(contextFor('plain').context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('keeps super-admin routes to super admins', async () => {
    await expect(guard().canActivate(contextFor('superAdminOnly').context)).rejects.toThrow(
      ForbiddenException,
    );

    prisma.userSession.findFirst.mockResolvedValue({
      user: staff({ platformRole: PlatformRole.SUPER_ADMIN }),
    });
    await expect(guard().canActivate(contextFor('superAdminOnly').context)).resolves.toBe(true);
  });

  it('allows only the password change until a temporary password is replaced', async () => {
    prisma.userSession.findFirst.mockResolvedValue({
      user: staff({ passwordChangeRequired: true }),
    });

    const error = await guard()
      .canActivate(contextFor('plain').context)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual(
      expect.objectContaining({ code: 'PASSWORD_CHANGE_REQUIRED' }),
    );
    await expect(guard().canActivate(contextFor('changePassword').context)).resolves.toBe(true);
  });

  describe('permissions', () => {
    it("refuses a moderator a route they weren't given, saying why", async () => {
      const error = await guard()
        .canActivate(contextFor('readUsers').context)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toEqual(
        expect.objectContaining({ code: 'MISSING_PERMISSION' }),
      );
    });

    it('lets a stronger permission cover the weaker one, and attaches what they may do', async () => {
      prisma.userSession.findFirst.mockResolvedValue({
        user: staff({ adminPermissions: [AdminPermission.MANAGE_USERS] }),
      });
      const { context, request } = contextFor('readUsers');

      await expect(guard().canActivate(context)).resolves.toBe(true);
      await expect(guard().canActivate(contextFor('editUser').context)).resolves.toBe(true);
      expect(request.admin).toEqual(
        expect.objectContaining({
          permissions: [AdminPermission.VIEW_USERS, AdminPermission.MANAGE_USERS],
        }),
      );
    });

    it('stops a moderator who can only look from changing anything', async () => {
      prisma.userSession.findFirst.mockResolvedValue({
        user: staff({ adminPermissions: [AdminPermission.VIEW_USERS] }),
      });
      await expect(guard().canActivate(contextFor('editUser').context)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('gives a super admin every permission', async () => {
      prisma.userSession.findFirst.mockResolvedValue({
        user: staff({ platformRole: PlatformRole.SUPER_ADMIN }),
      });
      await expect(guard().canActivate(contextFor('editUser').context)).resolves.toBe(true);
    });
  });
});
