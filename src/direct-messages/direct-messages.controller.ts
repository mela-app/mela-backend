import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CursorQueryDto } from '../social/dto/cursor-query.dto';
import { DirectMessagesService } from './direct-messages.service';
import { ConversationHistoryQueryDto } from './dto/conversation-history-query.dto';
import { SendDirectMessageDto } from './dto/send-direct-message.dto';

/** The signed-in user's conversations, each named by the other person's id. */
@Controller('me/conversations')
@UseGuards(JwtAuthGuard)
export class DirectMessagesController {
  constructor(private readonly messages: DirectMessagesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: CursorQueryDto) {
    return this.messages.listConversations(user.id, query.cursor, query.limit);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.messages.unreadCount(user.id);
  }

  @Get(':userId/messages')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: ConversationHistoryQueryDto,
  ) {
    return this.messages.history(user.id, userId, query);
  }

  @Post(':userId/messages')
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SendDirectMessageDto,
  ) {
    return this.messages.send(user.id, userId, dto.text, dto.clientId);
  }

  @Post(':userId/read')
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.messages.markRead(user.id, userId);
  }
}
