import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { VideoProviderKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { VideoControlService } from '../../video-control/video-control.service';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  CurrentAdmin,
  SuperAdminOnly,
} from '../admin.guard';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SwitchProviderDto {
  @IsEnum(VideoProviderKind)
  provider!: VideoProviderKind;

  // Kept with the switch, for the team.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class VideoSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  agoraFreeMinutes?: number;

  @IsOptional()
  @IsBoolean()
  autoSwitch?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  autoSwitchBelowMinutes?: number;

  @IsOptional()
  @IsBoolean()
  switchBackOnReset?: boolean;
}

/**
 * The console's Video page (docs/features/video-provider.md): where new
 * lives go, and Agora's free minutes. Super admins only - a switch reaches
 * every host's next live.
 */
@Controller('admin/video')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@SuperAdminOnly()
export class AdminVideoController {
  constructor(private readonly video: VideoControlService) {}

  @Get()
  overview() {
    return this.video.overview();
  }

  @Post('switch')
  @HttpCode(HttpStatus.OK)
  async switchProvider(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: SwitchProviderDto) {
    await this.video.switchTo(admin, dto.provider, dto.reason || 'Switched from the console');
    return this.video.overview();
  }

  @Patch('settings')
  updateSettings(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: VideoSettingsDto) {
    return this.video.updateSettings(admin, dto);
  }

  // Agora's usage report now, instead of at the next half hour.
  @Post('agora-report')
  @HttpCode(HttpStatus.OK)
  async refreshAgoraReport() {
    await this.video.reportFromAgora();
    return this.video.overview();
  }
}
