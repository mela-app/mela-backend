import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageProvider, UploadUrl } from './storage-provider.interface';

const UPLOAD_URL_TTL_SECONDS = 5 * 60;
// Deletes in flight at once.
const DELETE_CONCURRENCY = 10;

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
      // By default an upload URL carries the empty body's checksum, so S3 would reject every real file.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async createUploadUrl(key: string, contentType: string): Promise<UploadUrl> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    });
    return { uploadUrl, publicUrl: this.publicUrl(key) };
  }

  publicUrl(key: string): string {
    return `${this.publicUrlBase}/${key}`;
  }

  async deleteUrls(urls: string[]): Promise<void> {
    const base = `${this.publicUrlBase}/`;
    if (base === '/') return;
    const keys = [
      ...new Set(urls.filter((url) => url.startsWith(base)).map((url) => url.slice(base.length))),
    ].filter(Boolean);
    // One object at a time per request: DeleteObjects needs a checksum some S3 lookalikes refuse.
    for (let start = 0; start < keys.length; start += DELETE_CONCURRENCY) {
      await Promise.all(
        keys
          .slice(start, start + DELETE_CONCURRENCY)
          .map((key) =>
            this.client
              .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
              .catch((error: unknown) => this.logger.warn(`Could not delete ${key}: ${error}`)),
          ),
      );
    }
  }
}
