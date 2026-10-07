import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../common/storage/storage.module';
import { SocialModule } from '../social/social.module';
import { StreamsModule } from '../streams/streams.module';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // AuthModule: JwtAuthGuard/OptionalJwtAuthGuard, and proving it's the owner.
  // SocialModule: follow graph + search. StorageModule: presigned avatar
  // uploads, and deleting files. StreamsModule: ending a deleted host's live.
  imports: [AuthModule, SocialModule, StorageModule, StreamsModule],
  controllers: [UsersController, AccountDeletionController],
  providers: [UsersService, AccountDeletionService],
  // The admin console deletes accounts for people who asked without the app.
  exports: [AccountDeletionService],
})
export class UsersModule {}
