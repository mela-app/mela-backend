import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { AdminPermission, PlatformRole, SessionPlatform, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService } from '../../auth/auth.service';
import { ALL_ADMIN_PERMISSIONS } from '../../common/permissions/admin-permissions';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AdminPrincipal } from '../admin.guard';
import { AdminAuthService, DEFAULT_ADMIN_SESSION_MAX_AGE_SECONDS } from './admin-auth.service';

describe('AdminAuthService', () => {
  const prisma = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    userSession: { findUnique: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() },
  };
  const auth = {
    startSessionFor: jest.fn(),
    refresh: jest.fn(),
    endSession: jest.fn(),
    revokeOtherSessions: jest.fn(),
  };
  const jwt = { decode: jest.fn() };
  const config = { get: jest.fn(() => undefined) };
  const events = { emit: jest.fn() };
  const rateLimit = { take: jest.fn() };
  const tokens = { accessToken: 'access', refreshToken: 'refresh' };
  let passwordHash: string;

  const admin: AdminPrincipal = {
    id: 'admin-1',
    username: 'admin',
    email: 'admin@example.com',
    displayName: 'Admin',
    avatarUrl: null,
    platformRole: PlatformRole.SUPER_ADMIN,
    permissions: [...ALL_ADMIN_PERMISSIONS],
    passwordChangeRequired: false,
    sessionId: 'session-1',
  };

  function account(overrides: Record<string, unknown> = {}) {
    return {
      id: 'admin-1',
      username: 'admin',
      email: 'admin@example.com',
      displayName: 'Admin',
      avatarUrl: null,
      platformRole: PlatformRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      passwordChangeRequired: false,
      adminPermissions: [],
      passwordHash,
      ...overrides,
    };
  }

  async function makeService() {
    const service = new AdminAuthService(
      prisma as unknown as PrismaService,
      auth as unknown as AuthService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      events as unknown as EventEmitter2,
      rateLimit as unknown as RateLimitService,
    );
    await service.onModuleInit();
    return service;
  }

  beforeAll(async () => {
    passwordHash = await argon2.hash('Current-password-1');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimit.take.mockResolvedValue(0);
    auth.startSessionFor.mockResolvedValue(tokens);
    auth.refresh.mockResolvedValue(tokens);
    prisma.user.update.mockImplementation(({ data }) => Promise.resolve(account(data)));
    prisma.user.findUniqueOrThrow.mockResolvedValue(account());
  });

  describe('sign-in', () => {
    it('starts a web session for active staff and records the sign-in', async () => {
      prisma.user.findFirst.mockResolvedValue(account());

      const session = await (
        await makeService()
      ).signIn({ email: 'Admin@Example.com', password: 'Current-password-1' });

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: { equals: 'Admin@Example.com', mode: 'insensitive' } },
      });
      expect(auth.startSessionFor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'admin-1' }),
        SessionPlatform.WEB,
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { lastLoginAt: expect.any(Date) },
      });
      expect(events.emit).toHaveBeenCalledWith('admin.signed_in', { userId: 'admin-1' });
      expect(session.tokens).toBe(tokens);
      expect(session.admin).not.toHaveProperty('passwordHash');
      expect(session.admin.permissions).toEqual([...ALL_ADMIN_PERMISSIONS]);
    });

    it('tells the console what a platform moderator was given, and what that includes', async () => {
      const moderator = account({
        platformRole: PlatformRole.PLATFORM_MODERATOR,
        adminPermissions: [AdminPermission.MANAGE_USERS],
      });
      prisma.user.findFirst.mockResolvedValue(moderator);
      prisma.user.update.mockResolvedValue(moderator);

      const session = await (
        await makeService()
      ).signIn({ email: 'admin@example.com', password: 'Current-password-1' });

      expect(session.admin.permissions).toEqual([
        AdminPermission.VIEW_USERS,
        AdminPermission.MANAGE_USERS,
      ]);
    });

    it.each([
      ['a wrong password', () => account(), 'wrong-password-1'],
      [
        'a regular app user',
        () => account({ platformRole: PlatformRole.USER }),
        'Current-password-1',
      ],
      [
        'a suspended staff member',
        () => account({ status: UserStatus.SUSPENDED }),
        'Current-password-1',
      ],
      ['an unknown email', () => null, 'Current-password-1'],
    ])('gives %s the same generic refusal', async (_case, row, password) => {
      prisma.user.findFirst.mockResolvedValue(row());

      await expect(
        (await makeService()).signIn({ email: 'admin@example.com', password }),
      ).rejects.toThrow(new UnauthorizedException('Incorrect email or password'));
      expect(auth.startSessionFor).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith('admin.sign_in_failed', {
        email: 'admin@example.com',
      });
    });

    it('slows down repeated attempts on one account without checking the password', async () => {
      rateLimit.take.mockResolvedValue(150_000);

      const error = await (
        await makeService()
      )
        .signIn({ email: 'Admin@Example.com', password: 'anything' })
        .catch((e: unknown) => e);

      expect(rateLimit.take).toHaveBeenCalledWith(
        'admin-sign-in:admin@example.com',
        expect.any(Object),
      );
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toEqual(
        expect.objectContaining({
          code: 'TOO_MANY_ATTEMPTS',
          message: expect.stringContaining('3 minutes'),
        }),
      );
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith('admin.sign_in_failed', {
        email: 'Admin@Example.com',
        reason: 'rate_limited',
      });
    });

    it('still lets staff sign in when the limiter is unavailable', async () => {
      rateLimit.take.mockRejectedValue(new Error('Redis down'));
      prisma.user.findFirst.mockResolvedValue(account());

      await expect(
        (await makeService()).signIn({
          email: 'admin@example.com',
          password: 'Current-password-1',
        }),
      ).resolves.toEqual(expect.objectContaining({ tokens }));
    });
  });

  describe('refresh', () => {
    beforeEach(() => {
      jwt.decode.mockReturnValue({ sub: 'admin-1', sid: 'session-1' });
    });

    it('needs the refresh cookie', async () => {
      await expect((await makeService()).refresh(undefined)).rejects.toThrow(UnauthorizedException);
    });

    it("won't turn an app session into a console session", async () => {
      prisma.userSession.findUnique.mockResolvedValue({
        createdAt: new Date(),
        platform: SessionPlatform.ANDROID,
      });

      await expect((await makeService()).refresh('refresh')).rejects.toThrow(UnauthorizedException);
      expect(auth.refresh).not.toHaveBeenCalled();
    });

    it('ends a console session past its maximum age, however active', async () => {
      const tooOld = new Date(Date.now() - (DEFAULT_ADMIN_SESSION_MAX_AGE_SECONDS + 60) * 1000);
      prisma.userSession.findUnique.mockResolvedValue({
        createdAt: tooOld,
        platform: SessionPlatform.WEB,
      });

      await expect((await makeService()).refresh('refresh')).rejects.toThrow(/expired/);
      expect(auth.endSession).toHaveBeenCalledWith('refresh');
      expect(auth.refresh).not.toHaveBeenCalled();
    });

    it('rotates a live console session', async () => {
      prisma.userSession.findUnique.mockResolvedValue({
        createdAt: new Date(),
        platform: SessionPlatform.WEB,
      });
      prisma.user.findUnique.mockResolvedValue(account());

      const session = await (await makeService()).refresh('refresh');

      expect(auth.refresh).toHaveBeenCalledWith('refresh');
      expect(session.admin.id).toBe('admin-1');
    });

    it('ends the session of someone no longer staff', async () => {
      prisma.userSession.findUnique.mockResolvedValue({
        createdAt: new Date(),
        platform: SessionPlatform.WEB,
      });
      prisma.user.findUnique.mockResolvedValue(account({ platformRole: PlatformRole.USER }));

      await expect((await makeService()).refresh('refresh')).rejects.toThrow(UnauthorizedException);
      expect(auth.endSession).toHaveBeenCalledWith(tokens.refreshToken);
    });
  });

  describe('changing credentials', () => {
    it('needs the current password', async () => {
      await expect(
        (await makeService()).changePassword(admin, {
          currentPassword: 'nope',
          newPassword: 'A-new-password-2',
        }),
      ).rejects.toThrow(new BadRequestException('Your current password is incorrect'));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('explains what is wrong with a weak new password', async () => {
      await expect(
        (await makeService()).changePassword(admin, {
          currentPassword: 'Current-password-1',
          newPassword: 'short1',
        }),
      ).rejects.toThrow(/at least 12 characters/);
    });

    it('wants a password different from the current one', async () => {
      await expect(
        (await makeService()).changePassword(admin, {
          currentPassword: 'Current-password-1',
          newPassword: 'Current-password-1',
        }),
      ).rejects.toThrow(/different/);
    });

    it('replaces the password, clears the first-sign-in flag and signs other devices out', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(account({ passwordChangeRequired: true }));

      const view = await (
        await makeService()
      ).changePassword(admin, {
        currentPassword: 'Current-password-1',
        newPassword: 'A-new-password-2',
      });

      const { data } = prisma.user.update.mock.calls[0][0];
      expect(data.passwordChangeRequired).toBe(false);
      expect(await argon2.verify(data.passwordHash, 'A-new-password-2')).toBe(true);
      expect(auth.revokeOtherSessions).toHaveBeenCalledWith('admin-1', 'session-1');
      expect(events.emit).toHaveBeenCalledWith('account.password_changed', { userId: 'admin-1' });
      expect(view.passwordChangeRequired).toBe(false);
    });

    it('refuses an email address another account uses', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'someone-else' });

      await expect(
        (await makeService()).changeEmail(admin, {
          email: 'taken@example.com',
          currentPassword: 'Current-password-1',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('changes the email after checking the password', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const view = await (
        await makeService()
      ).changeEmail(admin, {
        email: 'new@example.com',
        currentPassword: 'Current-password-1',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { email: 'new@example.com' },
      });
      expect(events.emit).toHaveBeenCalledWith('account.email_changed', { userId: 'admin-1' });
      expect(view.email).toBe('new@example.com');
    });
  });

  describe('sessions', () => {
    it('marks the current device', async () => {
      prisma.userSession.findMany.mockResolvedValue([{ id: 'session-1' }, { id: 'session-2' }]);

      const { items } = await (await makeService()).sessions(admin);

      expect(items).toEqual([
        { id: 'session-1', current: true },
        { id: 'session-2', current: false },
      ]);
    });

    it('signs out another device, but not this one', async () => {
      const service = await makeService();
      await expect(service.revokeSession(admin, 'session-1')).rejects.toThrow(BadRequestException);

      prisma.userSession.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.revokeSession(admin, 'session-9')).rejects.toThrow(NotFoundException);

      prisma.userSession.deleteMany.mockResolvedValue({ count: 1 });
      await expect(service.revokeSession(admin, 'session-2')).resolves.toEqual({ ok: true });
      expect(prisma.userSession.deleteMany).toHaveBeenLastCalledWith({
        where: { id: 'session-2', userId: 'admin-1' },
      });
    });
  });
});
