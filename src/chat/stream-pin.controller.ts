import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';
import { PinMessageDto } from './dto/pin-message.dto';

/** `POST/DELETE /streams/:id/pin` (plan §6.13) - a sibling of ChatController's `streams/:streamId/chat`. */
@Controller('streams/:streamId')
@UseGuards(JwtAuthGuard)
export class StreamPinController {
  constructor(private readonly chat: ChatService) {}

  @Post('pin')
  async pin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @Body() dto: PinMessageDto,
  ) {
    const result = await this.chat.pin(streamId, dto.messageId, user.id);
    if (result.ok) return { ok: true };
    if (result.error === 'NOT_ALLOWED') throw new ForbiddenException('Only the host or a moderator can pin a message');
    throw new NotFoundException('Stream or message not found');
  }

  @Delete('pin')
  async unpin(@CurrentUser() user: AuthenticatedUser, @Param('streamId', ParseUUIDPipe) streamId: string) {
    const result = await this.chat.unpin(streamId, user.id);
    if (result.ok) return { ok: true };
    if (result.error === 'NOT_ALLOWED') throw new ForbiddenException('Only the host or a moderator can unpin a message');
    throw new NotFoundException('Stream not found');
  }
}
