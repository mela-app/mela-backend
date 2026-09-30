import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { PresenceModule } from '../common/presence/presence.module';
import { ModeratorsModule } from '../moderators/moderators.module';
import { RecordingPermissionsModule } from '../recording-permissions/recording-permissions.module';
import { RoomBansModule } from '../room-bans/room-bans.module';
import { RoomChatMutesModule } from '../room-chat-mutes/room-chat-mutes.module';
import { StreamsModule } from '../streams/streams.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  // AuthModule: JwtService + session checks. StreamsModule: live lookups -
  // one-way; streams reach sockets only through domain events. ChatModule:
  // the chat and likes pipelines behind chat:send and like:send. RoomBansModule:
  // the stream:join ban check. RoomChatMutesModule: the joiner's own mute.
  // ModeratorsModule: who moderates a live, for everyone in it.
  // RecordingPermissionsModule: whether the joiner may record.
  imports: [
    AuthModule,
    StreamsModule,
    PresenceModule,
    ChatModule,
    RoomBansModule,
    RoomChatMutesModule,
    ModeratorsModule,
    RecordingPermissionsModule,
  ],
  providers: [RealtimeGateway],
  // The admin console's alerts reach rooms through it; everything else
  // reaches this gateway only through the domain-event bus.
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
