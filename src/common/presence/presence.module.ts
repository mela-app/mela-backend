import { Module } from '@nestjs/common';
import { LivePresenceService } from './live-presence.service';

@Module({
  providers: [LivePresenceService],
  exports: [LivePresenceService],
})
export class PresenceModule {}
