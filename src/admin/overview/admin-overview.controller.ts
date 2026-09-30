import { Controller, Get, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ADMIN_API_THROTTLE, AdminGuard, AdminPrincipal, CurrentAdmin } from '../admin.guard';
import { AdminOverviewService } from './admin-overview.service';

// Every staff member: the totals, plus the lists their permissions cover.
@Controller('admin/overview')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get()
  get(@CurrentAdmin() admin: AdminPrincipal) {
    return this.overview.overview(admin);
  }
}
