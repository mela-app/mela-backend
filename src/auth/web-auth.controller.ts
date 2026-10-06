import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { SessionPlatform } from '@prisma/client';
import { CookieOptions, Request, Response } from 'express';
import { readCookie } from '../common/http/read-cookie';
import { AuthService, TokenPair } from './auth.service';
import { IdentitySignupDto, IdentityTokenDto } from './dto/identity.dto';
import { LoginDto } from './dto/login.dto';
import { IdentitySignInService } from './identity/identity-sign-in.service';

// httpOnly and sent to these routes only: the page's script never sees it.
const REFRESH_COOKIE = 'mela_web_refresh';
const COOKIE_PATH = '/v1/auth/web';
// A cross-site form can't set a custom header; the share page's player always does.
const CLIENT_HEADER = 'x-requested-with';
const CLIENT = 'mela-web';

/**
 * Signing in on the web (the share page's player - docs/features/auth.md):
 * the same accounts and sessions as the app, but the refresh token lives in
 * an httpOnly cookie and only the short-lived access token reaches the page.
 */
@Controller('auth/web')
export class WebAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly identities: IdentitySignInService,
    private readonly config: ConfigService,
  ) {}

  /** Continue with Google: signed in, or what a new account would start with. */
  @Post('identity')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async continueWithIdentity(
    @Req() req: Request,
    @Body() dto: IdentityTokenDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertWebClient(req);
    const outcome = await this.identities.continueWith(dto.idToken, SessionPlatform.WEB);
    return outcome.status === 'SIGNED_IN'
      ? { status: outcome.status, ...this.respond(outcome.tokens, res) }
      : { status: outcome.status, ...outcome.profile };
  }

  @Post('identity/signup')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async createAccount(
    @Req() req: Request,
    @Body() dto: IdentitySignupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertWebClient(req);
    const tokens = await this.identities.createAccount({ ...dto, platform: SessionPlatform.WEB });
    return this.respond(tokens, res);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Req() req: Request,
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertWebClient(req);
    return this.respond(await this.auth.login({ ...dto, platform: SessionPlatform.WEB }), res);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertWebClient(req);
    try {
      return this.respond(await this.auth.refresh(readCookie(req, REFRESH_COOKIE) ?? ''), res);
    } catch (error) {
      res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertWebClient(req);
    const refreshToken = readCookie(req, REFRESH_COOKIE);
    if (refreshToken) await this.auth.logout(refreshToken);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  private respond(tokens: TokenPair, res: Response) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...this.cookieOptions(),
      maxAge: this.auth.refreshTtlSeconds() * 1000,
    });
    return { accessToken: tokens.accessToken };
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.get<string>('NODE_ENV') === 'production',
      path: COOKIE_PATH,
    };
  }
}

function assertWebClient(req: Request): void {
  if (req.headers[CLIENT_HEADER] !== CLIENT) throw new ForbiddenException('Unsupported client');
}
