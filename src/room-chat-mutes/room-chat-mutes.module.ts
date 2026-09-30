import { Module } from '@nestjs/common';
import { RoomChatMutesService } from './room-chat-mutes.service';

@Module({
  providers: [RoomChatMutesService],
  // Its own module, not ChatModule's: StreamsModule (the mute endpoints),
  // ChatModule (enforcement) and RealtimeModule (join resync) all need it,
  // and ChatModule already imports StreamsModule.
  exports: [RoomChatMutesService],
})
export class RoomChatMutesModule {}
