import {
  Body,
  Controller,
  Delete,
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
import { AdminChatLogQueryDto, AdminStreamsQueryDto, LockStreamDto } from './admin-streams.dto';
import { AdminStreamsService } from './admin-streams.service';

@Controller('admin/streams')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_LIVES)
export class AdminStreamsController {
  constructor(private readonly streams: AdminStreamsService) {}

  @Get()
  list(@Query() query: AdminStreamsQueryDto) {
    return this.streams.list(query);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.streams.detail(id);
  }

  @Get(':id/chat')
  chatLog(@Param('id', ParseUUIDPipe) id: string, @Query() query: AdminChatLogQueryDto) {
    return this.streams.chatLog(id, query);
  }

  @Delete(':id/chat/:messageId')
  @RequirePermission(AdminPermission.MANAGE_LIVES)
  deleteMessage(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.streams.deleteMessage(admin, id, messageId);
  }

  @Post(':id/lock')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_LIVES)
  lock(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LockStreamDto,
  ) {
    return this.streams.lock(admin, id, dto.reason);
  }

  @Post(':id/unlock')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_LIVES)
  unlock(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.streams.unlock(admin, id);
  }
}
