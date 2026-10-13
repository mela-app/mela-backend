import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { SocialModule } from '../social/social.module';
import { AccountDeletionPageController } from './account-deletion-page.controller';
import { GetMelaController } from './get-mela.controller';
import { ProfileLinkController } from './profile-link.controller';
import { ShareController } from './share.controller';
import { ShareService } from './share.service';
import { WebFallbackController } from './web-fallback.controller';
import { WellKnownController } from './well-known.controller';

@Module({
  // AuthModule: the JWT guard. SocialModule: the friends-only check.
  // RateLimitModule: anti-spam on invites.
  imports: [AuthModule, SocialModule, RateLimitModule],
  controllers: [
    ShareController,
    WebFallbackController,
    ProfileLinkController,
    WellKnownController,
    AccountDeletionPageController,
    GetMelaController,
  ],
  providers: [ShareService],
})
export class ShareModule {}
