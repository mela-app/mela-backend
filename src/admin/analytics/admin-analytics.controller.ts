import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminPermission } from '@prisma/client';
import { Matches } from 'class-validator';
import { ADMIN_API_THROTTLE, AdminGuard, RequirePermission } from '../admin.guard';
import { AdminAnalyticsService } from './admin-analytics.service';

export class AnalyticsQueryDto {
  // First and last day, UTC, e.g. 2026-10-01.
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;
}

@Controller('admin/analytics')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_ANALYTICS)
export class AdminAnalyticsController {
  constructor(private readonly analytics: AdminAnalyticsService) {}

  @Get()
  overview(@Query() query: AnalyticsQueryDto) {
    return this.analytics.overview(query.from, query.to);
  }
}
