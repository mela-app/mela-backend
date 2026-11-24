import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { appClientOf } from '../activity/activity.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { CrashReportsDto } from './app-crashes.dto';
import { AppCrashesService } from './app-crashes.service';

/**
 * What went wrong on a phone (docs/features/app-crashes.md) - signed in or
 * not: a crash on the sign-in screen matters too. The app version comes from
 * its X-Mela-* headers.
 */
@Controller('app')
export class AppCrashesController {
  constructor(private readonly crashes: AppCrashesService) {}

  @Post('crashes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  report(
    @Body() dto: CrashReportsDto,
    @Headers() headers: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.crashes.record(dto.reports, appClientOf(headers), user?.id ?? null);
  }
}
