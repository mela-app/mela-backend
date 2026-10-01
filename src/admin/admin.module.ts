import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { PresenceModule } from '../common/presence/presence.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { StreamsModule } from '../streams/streams.module';
import { AdminGuard } from './admin.guard';
import { AdminAuditController } from './audit/admin-audit.controller';
import { AdminAccountController, AdminAuthController } from './auth/admin-auth.controller';
import { AdminAuthService } from './auth/admin-auth.service';
import { AdminAlertsController, AdminBannedPhrasesController } from './content/admin-content.controller';
import { AdminContentService } from './content/admin-content.service';
import { AdminMessagesController } from './messages/admin-messages.controller';
import { AdminMessagesService } from './messages/admin-messages.service';
import { AdminOverviewController } from './overview/admin-overview.controller';
import { AdminOverviewService } from './overview/admin-overview.service';
import { AdminStreamsController } from './streams/admin-streams.controller';
import { AdminStreamsService } from './streams/admin-streams.service';
import { AdminStaffController, AdminUsersController } from './users/admin-users.controller';
import { AdminUsersService } from './users/admin-users.service';

/**
 * The admin console's API (plan §6.8) - every route under /v1/admin, behind
 * AdminGuard. Nothing else imports this module. See docs/features/admin.md.
 */
@Module({
  // AuthModule: sessions and JwtService. RealtimeModule: how many devices an alert reaches.
  imports: [
    AuthModule,
    StreamsModule,
    ChatModule,
    RealtimeModule,
    PresenceModule,
    RateLimitModule,
    AuditModule,
  ],
  controllers: [
    AdminAuthController,
    AdminAccountController,
    AdminOverviewController,
    AdminStreamsController,
    AdminUsersController,
    AdminStaffController,
    AdminAlertsController,
    AdminBannedPhrasesController,
    AdminAuditController,
    AdminMessagesController,
  ],
  providers: [
    AdminGuard,
    AdminAuthService,
    AdminOverviewService,
    AdminStreamsService,
    AdminUsersService,
    AdminContentService,
    AdminMessagesService,
  ],
})
export class AdminModule {}
