import {
  Body,
  Controller,
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
import {
  AdminChatHostsQueryDto,
  AdminHostChatQueryDto,
  DeleteChatMessagesDto,
} from './admin-chat.dto';
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

  @Post('messages/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(AdminPermission.MANAGE_LIVES)
  deleteMessages(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: DeleteChatMessagesDto) {
    return this.chat.deleteMessages(admin, dto.messageIds);
  }
}
