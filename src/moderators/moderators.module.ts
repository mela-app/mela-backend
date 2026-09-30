import { Module } from '@nestjs/common';
import { ModeratorsService } from './moderators.service';

@Module({
  // No controller here any more - moderator management is a stream-scoped
  // concern, so its routes live on StreamsController (plan §6.9, revised
  // 2026-09-26: a grant is scoped to the stream it was made for, not the
  // host's whole channel).
  providers: [ModeratorsService],
  // StreamsModule (bans + its own moderator routes), ChatModule (delete/pin)
  // and RealtimeModule all look grants up before a moderation action.
  exports: [ModeratorsService],
})
export class ModeratorsModule {}
