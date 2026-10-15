import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { PresenceModule } from '../common/presence/presence.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { StorageModule } from '../common/storage/storage.module';
import { DirectMessagesModule } from '../direct-messages/direct-messages.module';
import { CameraEffectsModule } from '../camera-effects/camera-effects.module';
import { HostingRestrictionsModule } from '../hosting-restrictions/hosting-restrictions.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { StreamsModule } from '../streams/streams.module';
import { UsersModule } from '../users/users.module';
import { AdminGuard } from './admin.guard';
import { AdminAuditController } from './audit/admin-audit.controller';
import { AdminAccountController, AdminAuthController } from './auth/admin-auth.controller';
import { AdminAuthService } from './auth/admin-auth.service';
import { AdminCameraEffectsController } from './camera-effects/admin-camera-effects.controller';
import { AdminChatController } from './chat/admin-chat.controller';
import { AdminChatService } from './chat/admin-chat.service';
import {
  AdminAlertsController,
  AdminBannedPhrasesController,
} from './content/admin-content.controller';
import { AdminContentService } from './content/admin-content.service';
import { AdminDataController } from './data/admin-data.controller';
import { AdminDataService } from './data/admin-data.service';
import {
  AdminHostingReasonsController,
  AdminHostingRestrictionsController,
} from './hosting/admin-hosting.controller';
import { AdminMessagesController } from './messages/admin-messages.controller';
import { AdminMessagesService } from './messages/admin-messages.service';
import { AdminOverviewController } from './overview/admin-overview.controller';
import { AdminOverviewService } from './overview/admin-overview.service';
import { AdminReleasesController } from './releases/admin-releases.controller';
import { AdminReleasesService } from './releases/admin-releases.service';
import { AdminReportsController } from './reports/admin-reports.controller';
import { AdminReportsService } from './reports/admin-reports.service';
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
  // StorageModule: the files removed data pointed at. DirectMessagesModule: erasing a reported message.
  imports: [
    AuthModule,
    StreamsModule,
    ChatModule,
    RealtimeModule,
    PresenceModule,
    RateLimitModule,
    AuditModule,
    StorageModule,
    DirectMessagesModule,
    UsersModule,
    HostingRestrictionsModule,
    CameraEffectsModule,
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
    AdminChatController,
    AdminReleasesController,
    AdminDataController,
    AdminReportsController,
    AdminHostingReasonsController,
    AdminHostingRestrictionsController,
    AdminCameraEffectsController,
  ],
  providers: [
    AdminGuard,
    AdminAuthService,
    AdminOverviewService,
    AdminStreamsService,
    AdminUsersService,
    AdminContentService,
    AdminMessagesService,
    AdminChatService,
    AdminReleasesService,
    AdminDataService,
    AdminReportsService,
  ],
})
export class AdminModule {}
