import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { SocialModule } from '../social/social.module';
import { DirectMessagesController } from './direct-messages.controller';
import { DirectMessagesService } from './direct-messages.service';

@Module({
  // AuthModule: the JWT guard. SocialModule: who follows whom. ChatModule:
  // live chat's phrase filter. RateLimitModule: each sender's pace.
  imports: [AuthModule, SocialModule, ChatModule, RateLimitModule],
  controllers: [DirectMessagesController],
  providers: [DirectMessagesService],
})
export class DirectMessagesModule {}
