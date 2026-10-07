import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminPermission } from '@prisma/client';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  CurrentAdmin,
  RequirePermission,
} from '../admin.guard';
import { AdminReportsQueryDto, ResolveReportDto } from './admin-reports.dto';
import { AdminReportsService } from './admin-reports.service';

@Controller('admin/reports')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_REPORTS)
export class AdminReportsController {
  constructor(private readonly reports: AdminReportsService) {}

  @Get()
  list(@Query() query: AdminReportsQueryDto) {
    return this.reports.list(query);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.detail(id);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_REPORTS)
  resolve(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveReportDto,
  ) {
    return this.reports.resolve(admin, id, dto.outcome, dto.note);
  }

  @Post(':id/remove-message')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_REPORTS)
  removeMessage(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.removeMessage(admin, id);
  }
}
