import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../common/storage/storage.module';
import { MyHostingController } from './hosting-restrictions.controller';
import { HostingReasonsService } from './hosting-reasons.service';
import { HostingRestrictionsService } from './hosting-restrictions.service';

/**
 * Pausing someone's hosting, with appeals (docs/features/hosting-restrictions.md).
 * Streams and scheduled lives ask `assertCanHost`, and react to its events
 * (ending the live, freeing stage seats, cancelling scheduled lives).
 */
@Module({
  // AuthModule: the JWT guard. StorageModule: appeal pictures.
  imports: [AuthModule, StorageModule],
  controllers: [MyHostingController],
  providers: [HostingRestrictionsService, HostingReasonsService],
  exports: [HostingRestrictionsService, HostingReasonsService],
})
export class HostingRestrictionsModule {}
