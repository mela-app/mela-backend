import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminPermission } from '@prisma/client';
import { ADMIN_API_THROTTLE, AdminGuard, RequirePermission } from '../admin.guard';
import { AdminChatHostsQueryDto, AdminHostChatQueryDto } from './admin-chat.dto';
import { AdminChatService } from './admin-chat.service';

@Controller('admin/chat')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_LIVES)
export class AdminChatController {
  constructor(private readonly chat: AdminChatService) {}

  @Get('hosts')
  hosts(@Query() query: AdminChatHostsQueryDto) {
    return this.chat.hosts(query);
  }

  @Get('hosts/:hostId')
  hostChat(@Param('hostId', ParseUUIDPipe) hostId: string, @Query() query: AdminHostChatQueryDto) {
    return this.chat.hostChat(hostId, query);
  }
}
