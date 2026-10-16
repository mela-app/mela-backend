import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './common/config/env.validation';
import { PrismaModule } from './common/prisma/prisma.module';
import { PermissionsModule } from './common/permissions/permissions.module';
import { VideoProviderModule } from './common/video-provider/video-provider.module';
import { RedisModule } from './common/redis/redis.module';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { RequestContextMiddleware } from './common/request-context/request-context';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { StreamsModule } from './streams/streams.module';
import { ChatModule } from './chat/chat.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ModeratorsModule } from './moderators/moderators.module';
import { RoomBansModule } from './room-bans/room-bans.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ShareModule } from './share/share.module';
import { ScheduledLivesModule } from './scheduled-lives/scheduled-lives.module';
import { GuestsModule } from './guests/guests.module';
import { AuditModule } from './audit/audit.module';
import { AdminModule } from './admin/admin.module';
import { DirectMessagesModule } from './direct-messages/direct-messages.module';
import { AppReleasesModule } from './app-releases/app-releases.module';
import { HostingRestrictionsModule } from './hosting-restrictions/hosting-restrictions.module';
import { LegalModule } from './legal/legal.module';
import { LiveBoardModule } from './live-board/live-board.module';
import { ReportsModule } from './reports/reports.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    // A dedicated connection, deliberately not RedisModule's shared client -
    // BullMQ requires maxRetriesPerRequest: null, which the rest of the app
    // doesn't want (it wants normal ioredis retry behavior).
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          ...parseRedisUrl(config.getOrThrow<string>('REDIS_URL')),
          maxRetriesPerRequest: null,
        },
      }),
    }),
    PrismaModule,
    PermissionsModule,
    VideoProviderModule,
    RedisModule,
    AuthModule,
    UsersModule,
    StreamsModule,
    ChatModule,
    RealtimeModule,
    ModeratorsModule,
    RoomBansModule,
    NotificationsModule,
    ShareModule,
    ScheduledLivesModule,
    GuestsModule,
    AuditModule,
    AdminModule,
    DirectMessagesModule,
    AppReleasesModule,
    ReportsModule,
    LegalModule,
    HostingRestrictionsModule,
    LiveBoardModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware, RequestLoggerMiddleware).forRoutes('*');
  }
}

function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password ? { password: parsed.password } : {}),
  };
}
