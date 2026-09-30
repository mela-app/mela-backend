import { Module } from '@nestjs/common';
import { RecordingPermissionsService } from './recording-permissions.service';

@Module({
  providers: [RecordingPermissionsService],
  // StreamsModule (the endpoints, and join) and RealtimeModule (the join resync) both need it.
  exports: [RecordingPermissionsService],
})
export class RecordingPermissionsModule {}
