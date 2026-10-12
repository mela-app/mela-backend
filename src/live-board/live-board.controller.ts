import { Body, Controller, Delete, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SetBoardDto } from './dto/set-board.dto';
import { LiveBoardService } from './live-board.service';

/** `PUT/DELETE /streams/:id/board` - the live's board (docs/features/streams.md). */
@Controller('streams/:streamId/board')
@UseGuards(JwtAuthGuard)
export class LiveBoardController {
  constructor(private readonly board: LiveBoardService) {}

  @Put()
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @Body() dto: SetBoardDto,
  ) {
    return this.board.set(streamId, user.id, dto);
  }

  @Delete()
  clear(
    @CurrentUser() user: AuthenticatedUser,
    @Param('streamId', ParseUUIDPipe) streamId: string,
  ) {
    return this.board.clear(streamId, user.id);
  }
}
