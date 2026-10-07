import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  CurrentAdmin,
  SuperAdminOnly,
} from '../admin.guard';
import { ClearDataDto, ResetDataDto } from './admin-data.dto';
import { AdminDataService } from './admin-data.service';

// Each asks for the password again: few tries, so it can't be guessed here.
const REMOVAL_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('admin/data')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@SuperAdminOnly()
export class AdminDataController {
  constructor(private readonly data: AdminDataService) {}

  @Get()
  overview() {
    return this.data.overview();
  }

  @Post('clear')
  @HttpCode(HttpStatus.OK)
  @Throttle(REMOVAL_THROTTLE)
  clear(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: ClearDataDto) {
    return this.data.clear(admin, dto.dataSet, dto.olderThanDays, dto.password);
  }

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @Throttle(REMOVAL_THROTTLE)
  reset(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: ResetDataDto) {
    return this.data.reset(admin, dto.password, dto.keep ?? []);
  }
}
