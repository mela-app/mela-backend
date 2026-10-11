import { Body, Controller, Delete, Get, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CursorQueryDto } from '../social/dto/cursor-query.dto';
import { MarkNotificationsReadDto } from './dto/mark-notifications-read.dto';
import { UpdateNotificationSettingsDto } from './dto/notification-settings.dto';
import { PushTokenDto } from './dto/push-token.dto';
import { NotificationsService } from './notifications.service';

@Controller('me')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: CursorQueryDto) {
    return this.notifications.list(user.id, query.cursor, query.limit);
  }

  @Get('notifications/unread-count')
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Post('notifications/read')
  markRead(@CurrentUser() user: AuthenticatedUser, @Body() dto: MarkNotificationsReadDto) {
    return this.notifications.markRead(user.id, dto);
  }

  @Put('push-token')
  setPushToken(@CurrentUser() user: AuthenticatedUser, @Body() dto: PushTokenDto) {
    return this.notifications.setPushToken(user.sessionId, dto.token, dto.installationId, user.id);
  }

  @Delete('push-token')
  clearPushToken(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.clearPushToken(user.sessionId);
  }

  @Get('notification-settings')
  getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.getSettings(user.id);
  }

  @Patch('notification-settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateNotificationSettingsDto,
  ) {
    return this.notifications.updateSettings(user.id, dto);
  }
}
