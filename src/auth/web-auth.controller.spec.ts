import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { WebAuthController } from './web-auth.controller';

describe('WebAuthController', () => {
  const auth = {
    login: jest.fn(),
    signup: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
    refreshTtlSeconds: jest.fn(() => 604800),
  };
  const config = { get: jest.fn() };
  const controller = new WebAuthController(auth as unknown as AuthService, config as unknown as ConfigService);
  const tokens = { accessToken: 'access-1', refreshToken: 'refresh-1' };

  function request(cookie?: string, client = 'mela-web'): Request {
    return { headers: { 'x-requested-with': client, ...(cookie && { cookie }) } } as unknown as Request;
  }

  function response(): Response & { cookie: jest.Mock; clearCookie: jest.Mock } {
    return { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response & {
      cookie: jest.Mock;
      clearCookie: jest.Mock;
    };
  }

  beforeEach(() => jest.clearAllMocks());

  it('signs in as a web session, keeping the refresh token in an httpOnly cookie only', async () => {
    auth.login.mockResolvedValueOnce(tokens);
    const res = response();

    const body = await controller.login(request(), { usernameOrEmail: 'ana', password: 'secret' }, res);

    expect(auth.login).toHaveBeenCalledWith({ usernameOrEmail: 'ana', password: 'secret', platform: 'WEB' });
    expect(body).toEqual({ accessToken: 'access-1' });
    expect(res.cookie).toHaveBeenCalledWith(
      'mela_web_refresh',
      'refresh-1',
      expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/v1/auth/web', maxAge: 604800000 }),
    );
  });

  it('signs up as a web session too', async () => {
    auth.signup.mockResolvedValueOnce(tokens);
    const dto = { username: 'ana', displayName: 'Ana', email: 'ana@example.com', password: 'secret123' };

    await expect(controller.signup(request(), dto, response())).resolves.toEqual({ accessToken: 'access-1' });
    expect(auth.signup).toHaveBeenCalledWith({ ...dto, platform: 'WEB' });
  });

  it('renews from the cookie, and drops a cookie that no longer works', async () => {
    auth.refresh.mockResolvedValueOnce(tokens);
    await expect(controller.refresh(request('mela_web_refresh=old'), response())).resolves.toEqual({
      accessToken: 'access-1',
    });
    expect(auth.refresh).toHaveBeenCalledWith('old');

    auth.refresh.mockRejectedValueOnce(new UnauthorizedException());
    const res = response();
    await expect(controller.refresh(request('mela_web_refresh=old'), res)).rejects.toThrow(UnauthorizedException);
    expect(res.clearCookie).toHaveBeenCalledWith('mela_web_refresh', expect.objectContaining({ path: '/v1/auth/web' }));
  });

  it('refuses anything but the player itself - a cross-site form cannot set the header', async () => {
    await expect(controller.refresh(request('mela_web_refresh=old', 'evil'), response())).rejects.toThrow(
      ForbiddenException,
    );
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('signs out the session in the cookie and clears it', async () => {
    const res = response();

    await controller.logout(request('mela_web_refresh=old'), res);

    expect(auth.logout).toHaveBeenCalledWith('old');
    expect(res.clearCookie).toHaveBeenCalledWith('mela_web_refresh', expect.anything());
  });
});
