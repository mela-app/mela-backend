import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { CookieOptions, Request, Response } from 'express';
import { readCookie } from '../../common/http/read-cookie';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  AllowPendingPasswordChange,
  CurrentAdmin,
} from '../admin.guard';
import {
  AdminSignInDto,
  ChangeEmailDto,
  ChangePasswordDto,
  UpdateAdminProfileDto,
} from './admin-auth.dto';
import { AdminAuthService, AdminSession } from './admin-auth.service';

// httpOnly, and sent to these three routes only: page script never sees it.
const REFRESH_COOKIE = 'gl_admin_refresh';
const COOKIE_PATH = '/v1/admin/auth';
// A cross-site form can't set a custom header; the console always does.
const CSRF_HEADER = 'x-requested-with';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async signIn(@Body() dto: AdminSignInDto, @Res({ passthrough: true }) res: Response) {
    return this.respond(await this.adminAuth.signIn(dto), res);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertConsoleRequest(req);
    try {
      return this.respond(await this.adminAuth.refresh(readCookie(req, REFRESH_COOKIE)), res);
    } catch (error) {
      res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
      throw error;
    }
  }

  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertConsoleRequest(req);
    await this.adminAuth.signOut(readCookie(req, REFRESH_COOKIE));
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  private respond(session: AdminSession, res: Response) {
    res.cookie(REFRESH_COOKIE, session.tokens.refreshToken, {
      ...this.cookieOptions(),
      maxAge: this.adminAuth.sessionMaxAgeSeconds() * 1000,
    });
    return { accessToken: session.tokens.accessToken, admin: session.admin };
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

@Controller('admin/me')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
export class AdminAccountController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Get()
  @AllowPendingPasswordChange()
  me(@CurrentAdmin() admin: AdminPrincipal) {
    return this.adminAuth.me(admin);
  }

  @Patch()
  updateProfile(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: UpdateAdminProfileDto) {
    return this.adminAuth.updateProfile(admin, dto);
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @AllowPendingPasswordChange()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  changePassword(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: ChangePasswordDto) {
    return this.adminAuth.changePassword(admin, dto);
  }

  @Post('email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  changeEmail(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: ChangeEmailDto) {
    return this.adminAuth.changeEmail(admin, dto);
  }

  @Get('sessions')
  sessions(@CurrentAdmin() admin: AdminPrincipal) {
    return this.adminAuth.sessions(admin);
  }

  @Delete('sessions/:sessionId')
  revokeSession(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.adminAuth.revokeSession(admin, sessionId);
  }
}

function assertConsoleRequest(req: Request): void {
  if (req.headers[CSRF_HEADER] !== 'admin-console')
    throw new ForbiddenException('Unsupported client');
}
