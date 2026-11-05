import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminPermission, AnnouncementTone, SessionPlatform } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CampaignAudience } from '../../campaigns/campaign-audience';
import { CampaignsService } from '../../campaigns/campaigns.service';
import { PageQueryDto } from '../../common/pagination/page-query.dto';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  CurrentAdmin,
  RequirePermission,
} from '../admin.guard';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
// An empty field clears it.
const blankToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class AudienceDto {
  @ValidateNested()
  @Type(() => CampaignAudience)
  audience: CampaignAudience = {};
}

export class CreateCampaignDto extends AudienceDto {
  // What the push shows: kept short, as phones cut it.
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(65)
  title!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  body!: string;

  // /live/<id> or /profile/<id>; empty: the app itself.
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(80)
  openPath?: string;

  // Empty or past: now.
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledAt?: Date;
}

export class AnnouncementDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(400)
  message!: string;

  @IsOptional()
  @IsEnum(AnnouncementTone)
  tone?: AnnouncementTone;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  linkUrl?: string | null;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(30)
  linkLabel?: string | null;

  // Null or left out: every platform.
  @IsOptional()
  @IsIn([SessionPlatform.ANDROID, SessionPlatform.IOS, null])
  platform?: SessionPlatform | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date | null;

  @IsOptional()
  @IsBoolean()
  dismissible?: boolean;
}

export class FeatureHostDto {
  @IsUUID()
  userId!: string;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(200)
  note?: string | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class FeaturedOrderDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  userIds!: string[];
}

/** The console's Campaigns page (docs/features/campaigns.md). */
@Controller('admin')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_CAMPAIGNS)
export class AdminCampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get('campaigns')
  list(@Query() query: PageQueryDto) {
    return this.campaigns.listCampaigns(query);
  }

  // How many it would reach - before sending.
  @Post('campaigns/audience-size')
  @HttpCode(HttpStatus.OK)
  audienceSize(@Body() dto: AudienceDto) {
    return this.campaigns.audienceSize(dto.audience);
  }

  @Post('campaigns')
  @RequirePermission(AdminPermission.MANAGE_CAMPAIGNS)
  create(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateCampaignDto) {
    return this.campaigns.createCampaign(admin, dto);
  }

  @Post('campaigns/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_CAMPAIGNS)
  cancel(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.cancelCampaign(admin, id);
  }

  @Delete('campaigns/:id')
  @RequirePermission(AdminPermission.MANAGE_CAMPAIGNS)
  deleteCampaign(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.deleteCampaign(admin, id);
  }

  @Get('announcements')
  announcements(@Query() query: PageQueryDto) {
    return this.campaigns.listAnnouncements(query);
  }

  @Post('announcements')
  @RequirePermission(AdminPermission.MANAGE_CAMPAIGNS)
  publish(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: AnnouncementDto) {
    return this.campaigns.createAnnouncement(admin, dto);
  }

  @Patch('announcements/:id')
  @RequirePermission(AdminPermission.MANAGE_CAMPAIGNS)
  update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnnouncementDto,
  ) {
    return this.campaigns.updateAnnouncement(admin, id, dto);
  }

  @Post('announcements/:id/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_CAMPAIGNS)
  end(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.endAnnouncement(admin, id);
  }

  @Delete('announcements/:id')
  @RequirePermission(AdminPermission.MANAGE_CAMPAIGNS)
  remove(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.deleteAnnouncement(admin, id);
  }

  @Get('featured-hosts')
  featured() {
    return this.campaigns.listFeatured();
  }

  @Post('featured-hosts')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_CAMPAIGNS)
  feature(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: FeatureHostDto) {
    return this.campaigns.feature(admin, dto);
  }

  @Put('featured-hosts/order')
  @RequirePermission(AdminPermission.MANAGE_CAMPAIGNS)
  reorder(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: FeaturedOrderDto) {
    return this.campaigns.reorderFeatured(admin, dto.userIds);
  }

  @Delete('featured-hosts/:userId')
  @RequirePermission(AdminPermission.MANAGE_CAMPAIGNS)
  unfeature(@CurrentAdmin() admin: AdminPrincipal, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.campaigns.unfeature(admin, userId);
  }
}
