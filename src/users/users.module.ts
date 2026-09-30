import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../common/storage/storage.module';
import { SocialModule } from '../social/social.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // AuthModule: JwtAuthGuard/OptionalJwtAuthGuard. SocialModule: follow graph
  // + search. StorageModule: presigned avatar uploads.
  imports: [AuthModule, SocialModule, StorageModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
