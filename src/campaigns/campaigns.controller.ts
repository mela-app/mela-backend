import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { appClientOf } from '../activity/activity.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CampaignsService } from './campaigns.service';

/** What the app asks of campaigns (docs/features/campaigns.md). */
@Controller()
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  // The banners to show now - signed in or not.
  @Get('announcements')
  async announcements(@Headers() headers: Record<string, unknown>) {
    const items = await this.campaigns.activeAnnouncements(appClientOf(headers).platform);
    return { items };
  }

  // The app was opened from this campaign's push.
  @Post('me/campaigns/:id/opened')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  opened(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.recordOpen(user.id, id);
  }
}
