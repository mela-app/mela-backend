import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppCrashesController } from './app-crashes.controller';
import { AppCrashesService } from './app-crashes.service';

/** Crash reports from the app; the console reads them (src/admin/crashes). */
@Module({
  // AuthModule: the optional sign-in guard's JWT service.
  imports: [AuthModule],
  controllers: [AppCrashesController],
  providers: [AppCrashesService],
})
export class AppCrashesModule {}
