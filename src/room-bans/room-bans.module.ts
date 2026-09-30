import { Module } from '@nestjs/common';
import { RoomBansService } from './room-bans.service';

@Module({
  providers: [RoomBansService],
  // StreamsModule (join enforcement + the ban/unban endpoints) and RealtimeModule (stream:join) both need it.
  exports: [RoomBansService],
})
export class RoomBansModule {}
