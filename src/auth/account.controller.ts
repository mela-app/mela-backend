import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AccountPasswordService } from './account-password.service';
import { AuthenticatedUser } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import { SetPasswordDto } from './dto/set-password.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

/** The signed-in account's own ways to sign in (docs/features/auth.md). */
@Controller('me')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private readonly passwords: AccountPasswordService) {}

  @Get('sign-in-methods')
  signInMethods(@CurrentUser() user: AuthenticatedUser) {
    return this.passwords.signInMethods(user.id);
  }

  @Put('password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  setPassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetPasswordDto) {
    return this.passwords.setPassword(user, dto);
  }
}
