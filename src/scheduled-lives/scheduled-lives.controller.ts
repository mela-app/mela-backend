import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { CreateScheduledLiveDto } from './dto/create-scheduled-live.dto';
import { ScheduledLivesService } from './scheduled-lives.service';

/** Lives announced ahead, and "Remind me" - docs/features/streams.md, "Scheduled lives". */
@Controller('scheduled-lives')
export class ScheduledLivesController {
  constructor(private readonly scheduled: ScheduledLivesService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateScheduledLiveDto) {
    return this.scheduled.create(user.id, dto);
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.scheduled.mine(user.id);
  }

  // The Following tab's "Coming up".
  @Get('following')
  @UseGuards(JwtAuthGuard)
  following(@CurrentUser() user: AuthenticatedUser) {
    return this.scheduled.following(user.id);
  }

  // A host's profile.
  @Get('hosts/:hostId')
  @UseGuards(OptionalJwtAuthGuard)
  ofHost(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('hostId', ParseUUIDPipe) hostId: string,
  ) {
    return this.scheduled.ofHost(hostId, user?.id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduled.cancel(id, user.id);
  }

  @Put(':id/reminder')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  remind(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduled.setReminder(id, user.id, true);
  }

  @Delete(':id/reminder')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  forget(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduled.setReminder(id, user.id, false);
  }
}
