import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { PermissionsModule } from '../common/permissions/permissions.module';
import { ModeratorsModule } from '../moderators/moderators.module';
import { LiveBoardController } from './live-board.controller';
import { LiveBoardService } from './live-board.service';

/** The live's board (docs/features/streams.md); phones hear of it through `stream:board`. */
@Module({
  // AuthModule: the JWT guard. ChatModule: the phrase filter. ModeratorsModule:
  // who holds EDIT_BOARD.
  imports: [AuthModule, ChatModule, PermissionsModule, ModeratorsModule],
  controllers: [LiveBoardController],
  providers: [LiveBoardService],
})
export class LiveBoardModule {}
