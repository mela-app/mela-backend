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
import { IsIn, IsOptional } from 'class-validator';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CursorQueryDto } from '../social/dto/cursor-query.dto';
import { DirectMessagesService } from './direct-messages.service';
import { ConversationHistoryQueryDto } from './dto/conversation-history-query.dto';
import { SendDirectMessageDto } from './dto/send-direct-message.dto';

export class DeleteMessageQueryDto {
  // everyone: the sender takes it back for both; me (default): only from this person's view.
  @IsOptional()
  @IsIn(['everyone', 'me'])
  for: 'everyone' | 'me' = 'me';
}

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

  // The sender changes a message's text, within 15 minutes of sending it.
  @Patch(':userId/messages/:messageId')
  edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: SendDirectMessageDto,
  ) {
    return this.messages.edit(user.id, userId, messageId, dto.text);
  }

  @Delete(':userId/messages/:messageId')
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Query() query: DeleteMessageQueryDto,
  ) {
    return query.for === 'everyone'
      ? this.messages.deleteForEveryone(user.id, userId, messageId)
      : this.messages.deleteForMe(user.id, userId, messageId);
  }

  // "Delete chat": out of this person's inbox, the other keeps theirs.
  @Delete(':userId/messages')
  clear(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.messages.clearConversation(user.id, userId);
  }

  @Post(':userId/read')
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.messages.markRead(user.id, userId);
  }
}
