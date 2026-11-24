import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminPermission } from '@prisma/client';
import { ADMIN_API_THROTTLE, AdminGuard, RequirePermission } from '../admin.guard';
import { CrashGroupsQueryDto, CrashReportsQueryDto } from './admin-crashes.dto';
import { AdminCrashesService } from './admin-crashes.service';

// Watching how a release does is part of app updates (docs/features/app-crashes.md).
@Controller('admin/crashes')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_APP_RELEASES)
export class AdminCrashesController {
  constructor(private readonly crashes: AdminCrashesService) {}

  @Get()
  groups(@Query() query: CrashGroupsQueryDto) {
    return this.crashes.groups(query);
  }

  @Get(':signature')
  reports(@Param('signature') signature: string, @Query() query: CrashReportsQueryDto) {
    return this.crashes.reports(signature, query);
  }
}
