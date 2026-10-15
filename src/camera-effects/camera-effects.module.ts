import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../common/storage/storage.module';
import { CameraEffectsController } from './camera-effects.controller';
import { CameraEffectsService } from './camera-effects.service';

/** Camera effects, makeup, backgrounds and the beauty rig (docs/features/camera-effects.md). */
@Module({
  // AuthModule: the JWT guard. StorageModule: the uploaded files.
  imports: [AuthModule, StorageModule],
  controllers: [CameraEffectsController],
  providers: [CameraEffectsService],
  exports: [CameraEffectsService],
})
export class CameraEffectsModule {}
