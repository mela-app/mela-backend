import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminPermission } from '@prisma/client';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  CurrentAdmin,
  RequirePermission,
} from '../admin.guard';
import { AdminConversationsQueryDto, AdminTranscriptQueryDto } from './admin-messages.dto';
import { AdminMessagesService } from './admin-messages.service';

@Controller('admin/messages')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_PRIVATE_MESSAGES)
export class AdminMessagesController {
  constructor(private readonly messages: AdminMessagesService) {}

  @Get('conversations')
  conversations(@Query() query: AdminConversationsQueryDto) {
    return this.messages.conversations(query);
  }

  @Get('conversations/:id')
  transcript(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminTranscriptQueryDto,
  ) {
    return this.messages.transcript(admin, id, query);
  }
}
