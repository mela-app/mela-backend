import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { IdentitySignupDto, IdentityTokenDto, UsernameQueryDto } from './dto/identity.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { IdentitySignInService } from './identity/identity-sign-in.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly identities: IdentitySignInService,
  ) {}

  // Older app versions only - their sign-up form never confirmed the email.
  @Post('signup')
  signup(): never {
    throw new BadRequestException({
      message: 'Update Mela to sign up - new accounts now confirm their email first.',
      code: 'APP_UPDATE_REQUIRED',
    });
  }

  /** Google, or a confirmed email: signed in, or what a new account would start with. */
  @Post('identity')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async continueWithIdentity(@Body() dto: IdentityTokenDto) {
    const outcome = await this.identities.continueWith(dto.idToken, dto.platform);
    return outcome.status === 'SIGNED_IN'
      ? { status: outcome.status, ...outcome.tokens }
      : { status: outcome.status, ...outcome.profile };
  }

  @Post('identity/signup')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  createAccount(@Body() dto: IdentitySignupDto) {
    return this.identities.createAccount(dto);
  }

  @Get('username-available')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async usernameAvailable(@Query() query: UsernameQueryDto) {
    return { available: await this.identities.isUsernameAvailable(query.username) };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // Identified by the device's refresh token rather than the access token, so
  // signing out still works after the 15-minute access token has expired.
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Body() dto: RefreshDto) {
    return this.authService.logout(dto.refreshToken);
  }
}
