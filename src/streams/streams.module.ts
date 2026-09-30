import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PermissionsModule } from '../common/permissions/permissions.module';
import { PresenceModule } from '../common/presence/presence.module';
import { VideoProviderModule } from '../common/video-provider/video-provider.module';
import { GuestsModule } from '../guests/guests.module';
import { ModeratorsModule } from '../moderators/moderators.module';
import { RecordingPermissionsModule } from '../recording-permissions/recording-permissions.module';
import { RoomBansModule } from '../room-bans/room-bans.module';
import { RoomChatMutesModule } from '../room-chat-mutes/room-chat-mutes.module';
import { SocialModule } from '../social/social.module';
import { LiveStreamSweeper } from './live-stream.sweeper';
import { StreamsController } from './streams.controller';
import { StreamsService } from './streams.service';

@Module({
  imports: [
    AuthModule,
    PermissionsModule,
    VideoProviderModule,
    PresenceModule,
    SocialModule,
    ModeratorsModule,
    RoomBansModule,
    GuestsModule,
    RoomChatMutesModule,
    RecordingPermissionsModule,
  ],
  controllers: [StreamsController],
  providers: [StreamsService, LiveStreamSweeper],
  // The realtime gateway looks lives up through it; StreamsModule itself
  // only ever reaches sockets through domain events.
  exports: [StreamsService],
})
export class StreamsModule {}
