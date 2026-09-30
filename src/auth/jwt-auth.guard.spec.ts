import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PlatformRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  const jwt = { verifyAsync: jest.fn() };
  const config = { get: jest.fn(() => 'secret') };
  const auth = { isSessionActive: jest.fn() };

  const guard = () =>
    new JwtAuthGuard(jwt as unknown as JwtService, config as unknown as ConfigService, auth as unknown as AuthService);

  function contextWith(headers: Record<string, string>) {
    const request: Record<string, unknown> = { headers };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    return { context, request };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', username: 'ana', platformRole: PlatformRole.USER, sid: 's1' });
    auth.isSessionActive.mockResolvedValue(true);
  });

  it('attaches the caller for a valid token on a session that is still open', async () => {
    const { context, request } = contextWith({ authorization: 'Bearer token' });

    await expect(guard().canActivate(context)).resolves.toBe(true);

    expect(auth.isSessionActive).toHaveBeenCalledWith('s1', 'u1');
    expect(request.user).toEqual({ id: 'u1', username: 'ana', platformRole: PlatformRole.USER, sessionId: 's1' });
  });

  it('stops an access token as soon as its session ends (sign out, suspension, sign out everywhere)', async () => {
    auth.isSessionActive.mockResolvedValue(false);
    await expect(guard().canActivate(contextWith({ authorization: 'Bearer token' }).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a token from before per-device sessions', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', username: 'ana' });
    await expect(guard().canActivate(contextWith({ authorization: 'Bearer token' }).context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(auth.isSessionActive).not.toHaveBeenCalled();
  });

  it('needs a bearer token', async () => {
    await expect(guard().canActivate(contextWith({}).context)).rejects.toThrow(UnauthorizedException);
  });
});
