import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SendInvitesDto } from './dto/send-invites.dto';
import { ShareService } from './share.service';

@Controller('streams')
export class ShareController {
  constructor(private readonly share: ShareService) {}

  @Post(':id/invites')
  @UseGuards(JwtAuthGuard)
  sendInvites(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendInvitesDto,
  ) {
    return this.share.sendInvites(id, user.id, dto.userIds);
  }
}
