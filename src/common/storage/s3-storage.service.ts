import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageProvider, UploadUrl } from './storage-provider.interface';

const UPLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * S3-compatible storage (S3Mock in dev, S3/R2 in production - identical API).
 * See docs/features/storage.md.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly bucket: string;
  private readonly publicUrlBase: string;
  private readonly client: S3Client;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>('S3_BUCKET') ?? '';
    this.publicUrlBase = (config.get<string>('S3_PUBLIC_URL_BASE') ?? '').replace(/\/+$/, '');
    const accessKeyId = config.get<string>('S3_ACCESS_KEY_ID') ?? '';
    const secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY') ?? '';
    const endpoint = config.get<string>('S3_ENDPOINT') || undefined;

    if (!this.bucket || !this.publicUrlBase || !accessKeyId || !secretAccessKey) {
      this.logger.warn(
        'S3_BUCKET / S3_PUBLIC_URL_BASE / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are not fully set - ' +
          'createUploadUrl() will fail until they are.',
      );
    }

    this.client = new S3Client({
      region: config.getOrThrow<string>('S3_REGION'),
      endpoint,
      // S3Mock/MinIO address buckets by path, not by subdomain; real S3/R2 ignore this when unset.
      forcePathStyle: Boolean(endpoint),
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async createUploadUrl(key: string, contentType: string): Promise<UploadUrl> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
    return { uploadUrl, publicUrl: this.publicUrl(key) };
  }

  publicUrl(key: string): string {
    return `${this.publicUrlBase}/${key}`;
  }
}
