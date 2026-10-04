import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PushProviderModule } from '../common/push/push-provider.module';
import { SocialModule } from '../social/social.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PUSH_QUEUE, PushQueueService } from './push-queue.service';
import { PushProcessor } from './push.processor';

@Module({
  // AuthModule: the JWT guard. SocialModule: follower fan-out + block checks.
  // PushProviderModule: the vendor behind PushProcessor. Everything else
  // reaches this module only through the domain-event bus (plan §4.1).
  imports: [
    AuthModule,
    SocialModule,
    PushProviderModule,
    BullModule.registerQueue({ name: PUSH_QUEUE }),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, PushQueueService, PushProcessor],
  exports: [NotificationsService],
})
export class NotificationsModule {}
