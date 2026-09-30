import { Module } from '@nestjs/common';
import { S3StorageProvider } from './s3-storage.service';
import { STORAGE_PROVIDER } from './storage-provider.interface';

@Module({
  providers: [{ provide: STORAGE_PROVIDER, useClass: S3StorageProvider }],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
