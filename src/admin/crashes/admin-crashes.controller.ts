import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  PipeTransform,
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
import { CrashGroupsQueryDto, CrashReportsQueryDto } from './admin-crashes.dto';
import { AdminCrashesService } from './admin-crashes.service';

// A crash's signature (crashSignature): 16 hex characters.
class SignaturePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[0-9a-f]{16}$/.test(value)) throw new BadRequestException('Not a crash signature');
    return value;
  }
}

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
  reports(
    @Param('signature', SignaturePipe) signature: string,
    @Query() query: CrashReportsQueryDto,
  ) {
    return this.crashes.reports(signature, query);
  }

  // Clearing crashes away (fixed, or noise) - managing releases, like withdrawing one.
  @Delete('reports/:id')
  @RequirePermission(AdminPermission.MANAGE_APP_RELEASES)
  removeReport(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.crashes.removeReport(admin, id);
  }

  @Delete(':signature')
  @RequirePermission(AdminPermission.MANAGE_APP_RELEASES)
  removeCrash(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('signature', SignaturePipe) signature: string,
  ) {
    return this.crashes.removeCrash(admin, signature);
  }
}
