import { Module } from '@nestjs/common';
import { AppReleasesService } from './app-releases.service';
import { AppUpdateController } from './app-update.controller';

/** The phones' side of app updates; the admin console publishes them (src/admin/releases). */
@Module({
  controllers: [AppUpdateController],
  providers: [AppReleasesService],
})
export class AppReleasesModule {}
