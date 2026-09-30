import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';
import { ChatHistoryQueryDto } from './dto/chat-history.dto';
import { ChatImageUploadUrlDto } from './dto/chat-image-upload-url.dto';

@Controller('streams/:streamId/chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  history(@Param('streamId', ParseUUIDPipe) streamId: string, @Query() query: ChatHistoryQueryDto) {
    return this.chat.history(streamId, query);
  }

  // The host's photo goes straight to storage; the message then names it by `imageKey`.
  @Post('image-upload-url')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  imageUploadUrl(
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChatImageUploadUrlDto,
  ) {
    return this.chat.createImageUploadUrl(streamId, user.id, dto.contentType);
  }
}
