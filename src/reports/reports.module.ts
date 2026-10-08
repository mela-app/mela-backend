import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { SocialModule } from '../social/social.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  // AuthModule: the JWT guard. SocialModule: blocking while reporting. RateLimitModule: each reporter's pace.
  imports: [AuthModule, SocialModule, RateLimitModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
