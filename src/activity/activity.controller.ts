import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ActivityService, appClientOf } from './activity.service';

export class RecordInstallDto {
  // The app's own id for this install.
  @IsString()
  @Matches(/^[A-Za-z0-9-]{8,64}$/)
  installationId!: string;

  // Google Play's install referrer, as Play gave it.
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  referrer?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  installedAt?: Date;
}

/** Where installs come from (docs/features/analytics.md) - no account needed, sent before sign-in too. */
@Controller('installs')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  record(@Body() dto: RecordInstallDto, @Headers() headers: Record<string, unknown>) {
    return this.activity.recordInstall({
      installationId: dto.installationId,
      referrer: dto.referrer,
      installedAt: dto.installedAt,
      app: appClientOf(headers),
    });
  }
}
