import { Module } from '@nestjs/common';
import { ModeratorsModule } from '../moderators/moderators.module';
import { GuestsService } from './guests.service';

@Module({
  // ModeratorsModule: who currently holds MANAGE_GUEST_REQUESTS for a stream.
  imports: [ModeratorsModule],
  providers: [GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
