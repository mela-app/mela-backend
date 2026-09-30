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
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminPermission, BannedPhraseSeverity } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/page-query.dto';
import { ADMIN_API_THROTTLE, AdminGuard, AdminPrincipal, CurrentAdmin, RequirePermission } from '../admin.guard';
import { BannedPhraseDto, SendAlertDto, TestPhraseDto, UpdateBannedPhraseDto } from './admin-content.dto';
import { AdminContentService } from './admin-content.service';

class PhrasesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(BannedPhraseSeverity)
  severity?: BannedPhraseSeverity;
}

@Controller('admin/alerts')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_ALERTS)
export class AdminAlertsController {
  constructor(private readonly content: AdminContentService) {}

  @Get()
  list(@Query() query: PageQueryDto) {
    return this.content.listAlerts(query);
  }

  // What the composer offers, without needing access to the lives pages.
  @Get('targets')
  @RequirePermission(AdminPermission.SEND_ALERTS)
  targets() {
    return this.content.alertTargets();
  }

  // Alerting everyone also needs SEND_GLOBAL_ALERTS, checked by the service.
  @Post()
  @RequirePermission(AdminPermission.SEND_ALERTS)
  send(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: SendAlertDto) {
    return this.content.sendAlert(admin, dto);
  }
}

@Controller('admin/banned-phrases')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_PHRASES)
export class AdminBannedPhrasesController {
  constructor(private readonly content: AdminContentService) {}

  @Get()
  list(@Query() query: PhrasesQueryDto) {
    return this.content.listPhrases(query.q, query.severity);
  }

  // Tries the live filter without changing anything.
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(@Body() dto: TestPhraseDto) {
    return this.content.testPhrase(dto.text);
  }

  @Post()
  @RequirePermission(AdminPermission.MANAGE_PHRASES)
  add(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: BannedPhraseDto) {
    return this.content.addPhrase(admin, dto);
  }

  @Patch(':id')
  @RequirePermission(AdminPermission.MANAGE_PHRASES)
  update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBannedPhraseDto,
  ) {
    return this.content.updatePhrase(admin, id, dto);
  }

  @Delete(':id')
  @RequirePermission(AdminPermission.MANAGE_PHRASES)
  remove(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.removePhrase(admin, id);
  }
}
