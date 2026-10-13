import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppealImageUploadUrlDto, SendAppealDto } from './dto/hosting.dto';
import { HostingRestrictionsService } from './hosting-restrictions.service';

/**
 * The host's own side of a hosting restriction (docs/features/hosting-restrictions.md):
 * `GET /v1/me/hosting` - paused or not, why, and the conversation with the team;
 * `POST appeal` - write to the team, with up to 3 pictures.
 */
@Controller('me/hosting')
@UseGuards(JwtAuthGuard)
export class MyHostingController {
  constructor(private readonly restrictions: HostingRestrictionsService) {}

  @Get()
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.restrictions.mine(user.id);
  }

  @Post('appeal-image-upload-url')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  imageUploadUrl(@CurrentUser() user: AuthenticatedUser, @Body() dto: AppealImageUploadUrlDto) {
    return this.restrictions.appealImageUploadUrl(user.id, dto.contentType);
  }

  @Post('appeal')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  appeal(@CurrentUser() user: AuthenticatedUser, @Body() dto: SendAppealDto) {
    return this.restrictions.appeal(user.id, dto);
  }
}
