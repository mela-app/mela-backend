import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminPermission } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/page-query.dto';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  CurrentAdmin,
  RequirePermission,
} from '../admin.guard';
import { PublishReleaseDto, UpdateReleaseDto } from './admin-releases.dto';
import { AdminReleasesService } from './admin-releases.service';

@Controller('admin/app-releases')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_APP_RELEASES)
export class AdminReleasesController {
  constructor(private readonly releases: AdminReleasesService) {}

  @Get()
  list(@Query() query: PageQueryDto) {
    return this.releases.list(query);
  }

  @Post()
  @RequirePermission(AdminPermission.MANAGE_APP_RELEASES)
  publish(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: PublishReleaseDto) {
    return this.releases.publish(admin, dto);
  }

  @Patch(':id')
  @RequirePermission(AdminPermission.MANAGE_APP_RELEASES)
  update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReleaseDto,
  ) {
    return this.releases.update(admin, id, dto);
  }

  @Delete(':id')
  @RequirePermission(AdminPermission.MANAGE_APP_RELEASES)
  withdraw(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.releases.withdraw(admin, id);
  }
}
