import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PermissionsModule } from '../common/permissions/permissions.module';
import { PresenceModule } from '../common/presence/presence.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { StorageModule } from '../common/storage/storage.module';
import { ModeratorsModule } from '../moderators/moderators.module';
import { RoomChatMutesModule } from '../room-chat-mutes/room-chat-mutes.module';
import { StreamsModule } from '../streams/streams.module';
import { BannedPhrasesService } from './banned-phrases.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { LikesService } from './likes.service';
import { StreamPinController } from './stream-pin.controller';

@Module({
  // AuthModule: the JWT guard. StreamsModule: live lookups. PresenceModule: like totals.
  // ModeratorsModule: capability grants for delete/pin. StorageModule: the host's photos.
  imports: [
    AuthModule,
    StreamsModule,
    PresenceModule,
    RateLimitModule,
    PermissionsModule,
    ModeratorsModule,
    RoomChatMutesModule,
    StorageModule,
  ],
  controllers: [ChatController, StreamPinController],
  providers: [ChatService, LikesService, BannedPhrasesService],
  // The realtime gateway runs chat:send and like:send through these; the
  // admin console removes messages and tries out the phrase filter.
  exports: [ChatService, LikesService, BannedPhrasesService],
})
export class ChatModule {}
