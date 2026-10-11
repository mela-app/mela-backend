import { Body, Controller, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StreamThumbnailsService } from './stream-thumbnails.service';

export class SetThumbnailDto {
  @IsString()
  @MaxLength(200)
  key!: string;
}

/** The running live's picture for discovery and link previews (host only) - see StreamThumbnailsService. */
@Controller('streams/:id/thumbnail')
@UseGuards(JwtAuthGuard)
// The app sends one about a minute apart; this leaves room for retries only.
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class StreamThumbnailsController {
  constructor(private readonly thumbnails: StreamThumbnailsService) {}

  @Post('upload-url')
  uploadUrl(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.thumbnails.uploadUrl(id, user.id);
  }

  @Put()
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetThumbnailDto,
  ) {
    return this.thumbnails.set(id, user.id, dto.key);
  }
}
