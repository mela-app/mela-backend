import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PlatformRole, SessionPlatform, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthService, hashToken, REFRESH_REUSE_GRACE_MS } from './auth.service';

describe('AuthService', () => {
  const prisma = {
    user: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  let signed = 0;
  const jwtService = {
    signAsync: jest.fn(() => Promise.resolve(`token-${++signed}`)),
    verifyAsync: jest.fn(),
  };
  const config = { get: () => undefined };
  const events = { emit: jest.fn() };
  const activeUser = {
    id: 'u1',
    username: 'alice',
    platformRole: PlatformRole.USER,
    status: UserStatus.ACTIVE,
  };

  function makeService() {
    return new AuthService(
      prisma as unknown as PrismaService,
      jwtService as unknown as JwtService,
      config as unknown as ConfigService,
      events as unknown as EventEmitter2,
    );
  }

  function sessionRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 's1',
      userId: 'u1',
      refreshTokenHash: hashToken('current-token'),
      previousRefreshTokenHash: null,
      rotatedAt: new Date(),
      user: activeUser,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    signed = 0;
    prisma.user.create.mockResolvedValue({
      id: 'new-user',
      username: 'a',
      platformRole: PlatformRole.USER,
    });
    prisma.user.update.mockResolvedValue({});
    prisma.userSession.create.mockResolvedValue({});
    prisma.userSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.userSession.deleteMany.mockResolvedValue({ count: 1 });
    jwtService.verifyAsync.mockResolvedValue({ sub: 'u1', username: 'alice', sid: 's1', jti: 'j' });
  });

  it('rejects login for an unknown user without revealing which field was wrong', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(makeService().login({ usernameOrEmail: 'nobody', password: 'x' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('turns away a password for an account made with Google, as for a wrong one', async () => {
    prisma.user.findFirst.mockResolvedValue({ ...activeUser, passwordHash: null });

    await expect(
      makeService().login({ usernameOrEmail: 'alice', password: 'password123' }),
    ).rejects.toThrow(new UnauthorizedException('Invalid credentials'));
    expect(prisma.userSession.create).not.toHaveBeenCalled();
  });

  it('tells a suspended account it is suspended, but only once the password is right', async () => {
    prisma.user.findFirst.mockResolvedValue({
      ...activeUser,
      status: UserStatus.SUSPENDED,
      passwordHash: await argon2.hash('password123'),
    });

    const failure = makeService()
      .login({ usernameOrEmail: 'alice', password: 'password123' })
      .catch((e: unknown) => e);
    const error = await failure;
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual(
      expect.objectContaining({ code: 'ACCOUNT_SUSPENDED' }),
    );
    expect(prisma.userSession.create).not.toHaveBeenCalled();

    // A wrong password must not reveal that the account exists, suspended or not.
    await expect(
      makeService().login({ usernameOrEmail: 'alice', password: 'wrong-password' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('records the sign-in time and announces the login', async () => {
    prisma.user.findFirst.mockResolvedValue({
      ...activeUser,
      passwordHash: await argon2.hash('password123'),
    });

    await makeService().login({
      usernameOrEmail: 'alice',
      password: 'password123',
      platform: SessionPlatform.IOS,
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { lastLoginAt: expect.any(Date) },
    });
    expect(events.emit).toHaveBeenCalledWith('user.logged_in', {
      userId: 'u1',
      platform: SessionPlatform.IOS,
      method: 'password',
    });
  });

  it('gives each login its own session, so a second device never signs the first out', async () => {
    prisma.user.findFirst.mockResolvedValue({
      ...activeUser,
      passwordHash: await argon2.hash('password123'),
    });
    const service = makeService();

    await service.login({
      usernameOrEmail: 'alice',
      password: 'password123',
      platform: SessionPlatform.ANDROID,
    });
    await service.login({
      usernameOrEmail: 'alice',
      password: 'password123',
      platform: SessionPlatform.IOS,
    });

    const created = prisma.userSession.create.mock.calls.map(([args]) => args.data);
    expect(created).toHaveLength(2);
    expect(created[0].id).not.toBe(created[1].id);
    expect(prisma.userSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.userSession.deleteMany).not.toHaveBeenCalledWith({
      where: { id: created[0].id },
    });
  });

  it('rotates the refresh token and remembers the previous one for the grace window', async () => {
    prisma.userSession.findUnique.mockResolvedValue(sessionRow());

    const result = await makeService().refresh('current-token');

    expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', refreshTokenHash: hashToken('current-token') },
      data: expect.objectContaining({
        previousRefreshTokenHash: hashToken('current-token'),
        refreshTokenHash: hashToken(result.refreshToken),
      }),
    });
    expect(result.refreshToken).not.toBe('current-token');
  });

  it('accepts the just-rotated token again within the grace window (lost response on a flaky network)', async () => {
    prisma.userSession.findUnique.mockResolvedValue(
      sessionRow({
        refreshTokenHash: hashToken('newer-token'),
        previousRefreshTokenHash: hashToken('current-token'),
      }),
    );

    await expect(makeService().refresh('current-token')).resolves.toEqual(
      expect.objectContaining({ refreshToken: expect.any(String) }),
    );
  });

  it('treats an old token replayed after the grace window as stolen and ends that session', async () => {
    prisma.userSession.findUnique.mockResolvedValue(
      sessionRow({
        refreshTokenHash: hashToken('newer-token'),
        previousRefreshTokenHash: hashToken('current-token'),
        rotatedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1000),
      }),
    );

    await expect(makeService().refresh('current-token')).rejects.toThrow(UnauthorizedException);
    expect(prisma.userSession.deleteMany).toHaveBeenCalledWith({ where: { id: 's1' } });
  });

  it('refuses to refresh a suspended user and ends all their sessions', async () => {
    prisma.userSession.findUnique.mockResolvedValue(
      sessionRow({ user: { ...activeUser, status: UserStatus.SUSPENDED } }),
    );

    await expect(makeService().refresh('current-token')).rejects.toThrow(UnauthorizedException);
    expect(prisma.userSession.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  it('rejects a refresh for a session that was signed out', async () => {
    prisma.userSession.findUnique.mockResolvedValue(null);

    await expect(makeService().refresh('current-token')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects refresh tokens issued before per-device sessions existed (no sid)', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: 'u1', username: 'alice' });

    await expect(makeService().refresh('legacy-token')).rejects.toThrow(UnauthorizedException);
    expect(prisma.userSession.findUnique).not.toHaveBeenCalled();
  });

  it('when two refreshes race, the loser retries against the rotated row instead of failing', async () => {
    prisma.userSession.findUnique.mockResolvedValueOnce(sessionRow()).mockResolvedValueOnce(
      sessionRow({
        refreshTokenHash: hashToken('winner-token'),
        previousRefreshTokenHash: hashToken('current-token'),
      }),
    );
    prisma.userSession.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(makeService().refresh('current-token')).resolves.toEqual(
      expect.objectContaining({ accessToken: expect.any(String) }),
    );
    expect(prisma.userSession.updateMany).toHaveBeenCalledTimes(2);
  });

  it('logout ends only the session behind that refresh token, even if it has expired', async () => {
    await makeService().logout('current-token');

    expect(jwtService.verifyAsync).toHaveBeenCalledWith(
      'current-token',
      expect.objectContaining({ ignoreExpiration: true }),
    );
    expect(prisma.userSession.deleteMany).toHaveBeenCalledWith({
      where: { id: 's1', userId: 'u1' },
    });
  });

  it('logout with a garbage token quietly does nothing', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('bad signature'));

    await expect(makeService().logout('garbage')).resolves.toBeUndefined();
    expect(prisma.userSession.deleteMany).not.toHaveBeenCalled();
  });

  it('ends every session of a user when they are suspended', async () => {
    await makeService().endAllSessions({ userId: 'u1', suspendedBy: 'admin-1' });

    expect(prisma.userSession.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });
});
