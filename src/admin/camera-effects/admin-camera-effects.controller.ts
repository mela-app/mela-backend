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
import { CameraEffectsService } from '../../camera-effects/camera-effects.service';
import {
  CameraEffectUploadUrlDto,
  CreateCameraEffectDto,
  ListCameraEffectsQueryDto,
  SaveCategoryDto,
  UpdateCameraEffectDto,
} from '../../camera-effects/dto/camera-effects.dto';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  CurrentAdmin,
  RequirePermission,
} from '../admin.guard';

/** The camera effects the app offers (docs/features/camera-effects.md). */
@Controller('admin/camera-effects')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_CAMERA_EFFECTS)
export class AdminCameraEffectsController {
  constructor(private readonly effects: CameraEffectsService) {}

  @Get()
  list(@Query() query: ListCameraEffectsQueryDto) {
    return this.effects.list(query.kind);
  }

  // Before ':id'.
  @Get('categories')
  categories() {
    return this.effects.categories();
  }

  @Post('categories')
  @RequirePermission(AdminPermission.MANAGE_CAMERA_EFFECTS)
  createCategory(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: SaveCategoryDto) {
    return this.effects.saveCategory(admin, null, dto);
  }

  @Patch('categories/:id')
  @RequirePermission(AdminPermission.MANAGE_CAMERA_EFFECTS)
  updateCategory(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveCategoryDto,
  ) {
    return this.effects.saveCategory(admin, id, dto);
  }

  @Delete('categories/:id')
  @RequirePermission(AdminPermission.MANAGE_CAMERA_EFFECTS)
  removeCategory(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.effects.removeCategory(admin, id);
  }

  @Post('upload-url')
  @RequirePermission(AdminPermission.MANAGE_CAMERA_EFFECTS)
  uploadUrl(@Body() dto: CameraEffectUploadUrlDto) {
    return this.effects.uploadUrl(dto.contentType);
  }

  @Post()
  @RequirePermission(AdminPermission.MANAGE_CAMERA_EFFECTS)
  create(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateCameraEffectDto) {
    return this.effects.create(admin, dto);
  }

  @Patch(':id')
  @RequirePermission(AdminPermission.MANAGE_CAMERA_EFFECTS)
  update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCameraEffectDto,
  ) {
    return this.effects.update(admin, id, dto);
  }

  @Delete(':id')
  @RequirePermission(AdminPermission.MANAGE_CAMERA_EFFECTS)
  remove(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.effects.remove(admin, id);
  }
}
