import {
  Body,
  Controller,
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
import { Throttle } from '@nestjs/throttler';
import { AdminPermission } from '@prisma/client';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  CurrentAdmin,
  RequirePermission,
  SuperAdminOnly,
} from '../admin.guard';
import {
  AdminUsersQueryDto,
  ChangePermissionsDto,
  ChangeRoleDto,
  CreateStaffDto,
  DeleteUserDto,
  EditUserProfileDto,
  SuspendUserDto,
} from './admin-users.dto';
import { AccountDeletionService } from '../../users/account-deletion.service';
import { AdminUsersService } from './admin-users.service';

@Controller('admin/users')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_USERS)
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly deletion: AccountDeletionService,
  ) {}

  @Get()
  list(@Query() query: AdminUsersQueryDto) {
    return this.users.list(query);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.detail(id);
  }

  @Get(':id/sessions')
  sessions(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.sessions(id);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_USERS)
  suspend(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendUserDto,
  ) {
    return this.users.suspend(admin, id, dto.reason);
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_USERS)
  reinstate(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.reinstate(admin, id);
  }

  @Post(':id/sessions/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_USERS)
  revokeSessions(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.revokeSessions(admin, id);
  }

  @Patch(':id/profile')
  @RequirePermission(AdminPermission.MANAGE_USERS)
  editProfile(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditUserProfileDto,
  ) {
    return this.users.editProfile(admin, id, dto);
  }

  @Patch(':id/role')
  @SuperAdminOnly()
  changeRole(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.users.changeRole(admin, id, dto.platformRole, dto.permissions);
  }

  @Patch(':id/permissions')
  @SuperAdminOnly()
  changePermissions(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangePermissionsDto,
  ) {
    return this.users.changePermissions(admin, id, dto.permissions);
  }

  // For someone who asked without the app (the /delete-account page).
  @Post(':id/delete')
  @HttpCode(HttpStatus.OK)
  @SuperAdminOnly()
  delete(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteUserDto,
  ) {
    return this.deletion.deleteByStaff(admin.id, id, dto.reason);
  }
}

// Every staff member sees who else is staff; only a super admin adds one.
@Controller('admin/staff')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
export class AdminStaffController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list() {
    return this.users.listStaff();
  }

  @Post()
  @SuperAdminOnly()
  create(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateStaffDto) {
    return this.users.createStaff(admin, dto);
  }
}
