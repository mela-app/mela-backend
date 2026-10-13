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
  AnswerAppealDto,
  InForceQueryDto,
  LiftRestrictionDto,
  ListReasonsQueryDto,
  ListRestrictionsQueryDto,
  RestrictHostDto,
  SaveReasonDto,
  UpdateReasonDto,
  UpdateRestrictionDto,
} from '../../hosting-restrictions/dto/hosting.dto';
import { HostingReasonsService } from '../../hosting-restrictions/hosting-reasons.service';
import { HostingRestrictionsService } from '../../hosting-restrictions/hosting-restrictions.service';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  CurrentAdmin,
  RequirePermission,
} from '../admin.guard';

/** The reasons staff pick from when pausing someone's hosting. */
@Controller('admin/hosting-reasons')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_HOSTING_RESTRICTIONS)
export class AdminHostingReasonsController {
  constructor(private readonly reasons: HostingReasonsService) {}

  @Get()
  list(@Query() query: ListReasonsQueryDto) {
    return this.reasons.list(query.archived ?? false);
  }

  @Post()
  @RequirePermission(AdminPermission.MANAGE_HOSTING_RESTRICTIONS)
  create(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: SaveReasonDto) {
    return this.reasons.create(admin, dto);
  }

  @Patch(':id')
  @RequirePermission(AdminPermission.MANAGE_HOSTING_RESTRICTIONS)
  update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReasonDto,
  ) {
    return this.reasons.update(admin, id, dto);
  }
}

/** Pausing someone's hosting, and the appeal (docs/features/hosting-restrictions.md). */
@Controller('admin/hosting-restrictions')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_HOSTING_RESTRICTIONS)
export class AdminHostingRestrictionsController {
  constructor(private readonly restrictions: HostingRestrictionsService) {}

  @Get()
  list(@Query() query: ListRestrictionsQueryDto) {
    return this.restrictions.list({ ...query, filter: query.state });
  }

  // Before ':id', which would take the word for an id.
  @Get('in-force')
  inForce(@Query() query: InForceQueryDto) {
    return this.restrictions.inForce(query.userIds);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.restrictions.detail(id);
  }

  @Post()
  @RequirePermission(AdminPermission.MANAGE_HOSTING_RESTRICTIONS)
  restrict(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: RestrictHostDto) {
    return this.restrictions.restrict(admin, dto);
  }

  @Post(':id/lift')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_HOSTING_RESTRICTIONS)
  lift(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LiftRestrictionDto,
  ) {
    return this.restrictions.lift(admin, id, dto.reply);
  }

  @Post(':id/answer')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_HOSTING_RESTRICTIONS)
  answer(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnswerAppealDto,
  ) {
    return this.restrictions.answer(admin, id, dto);
  }

  @Patch(':id')
  @RequirePermission(AdminPermission.MANAGE_HOSTING_RESTRICTIONS)
  update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRestrictionDto,
  ) {
    return this.restrictions.update(admin, id, dto);
  }
}
